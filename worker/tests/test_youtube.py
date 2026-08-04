from __future__ import annotations

import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from worker.whispersub_worker.engine import Segment
from worker.tests.test_protocol import valid_gemini_translation_message, valid_message
from worker.whispersub_worker.protocol import WorkerError, parse_start_job
from worker.whispersub_worker.youtube import (
    CaptionTrack,
    YoutubeDlClient,
    YoutubeSourceResolver,
    YoutubeVideo,
    _yt_dlp_runtime_error,
    sanitize_output_stem,
)


class YoutubeDlClientTest(unittest.TestCase):
    def test_audio_download_keeps_worker_stdout_reserved_for_jsonl(self) -> None:
        class ProgressPrintingYoutubeDL:
            def __init__(self, options: dict[str, object]) -> None:
                self.options = options

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def download(self, _urls: list[str]) -> int:
                if not self.options.get("noprogress"):
                    print("\r[download] 50.0%")
                output = Path(str(self.options["outtmpl"]).replace("%(ext)s", "webm"))
                output.write_bytes(b"audio fixture")
                return 0

        captured_stdout = io.StringIO()
        fake_module = SimpleNamespace(YoutubeDL=ProgressPrintingYoutubeDL)
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict("sys.modules", {"yt_dlp": fake_module}),
            redirect_stdout(captured_stdout),
        ):
            output = YoutubeDlClient().download_audio(
                "https://youtu.be/abc123def45", Path(directory)
            )

        self.assertEqual(captured_stdout.getvalue(), "")
        self.assertEqual(output.name, "audio.webm")


class FakeYoutubeClient:
    def __init__(self, video: YoutubeVideo, caption: str) -> None:
        self.video = video
        self.caption = caption
        self.downloaded: list[CaptionTrack] = []

    def inspect(self, _url: str) -> YoutubeVideo:
        return self.video

    def download_caption(self, _url: str, track: CaptionTrack, workspace: Path) -> Path:
        self.downloaded.append(track)
        path = workspace / f"caption.{track.language}.vtt"
        path.write_text(self.caption, encoding="utf-8")
        return path

    def download_audio(self, _url: str, workspace: Path) -> Path:
        path = workspace / "audio.webm"
        path.write_bytes(b"audio fixture")
        return path


def youtube_request(workspace: Path, source_language: str):
    message = valid_message() if source_language == "vi" else valid_gemini_translation_message()
    message.update(
        {
              "source": {"kind": "youtube", "url": "https://youtu.be/abc123"},
              "workspacePath": str(workspace),
              "youtubeCachePath": str(workspace / "cache"),
              "youtubeLibraryPath": str(workspace / "library"),
            "outputLocationMode": "custom_directory",
            "outputDirectory": str(workspace),
            "sourceLanguage": source_language,
            "targetLanguage": "vi",
        }
    )
    return parse_start_job(message)


class YoutubeResolverTest(unittest.TestCase):
    def test_vietnamese_manual_caption_is_resolved_locally(self) -> None:
        manual = CaptionTrack(language="vi", automatic=False, extension="vtt")
        automatic = CaptionTrack(language="vi", automatic=True, extension="vtt")
        client = FakeYoutubeClient(
            YoutubeVideo(
                video_id="abc123def45",
                title="Bài học: API/CLI",
                is_live=False,
                subtitles={"vi": (manual,)},
                automatic_captions={"vi": (automatic,)},
            ),
            "WEBVTT\n\n00:00:00.000 --> 00:00:02.500\nGiữ nguyên CLI.\n",
        )
        events: list[dict[str, object]] = []
        with tempfile.TemporaryDirectory() as directory:
            result = YoutubeSourceResolver(client).resolve_caption(
                youtube_request(Path(directory), "vi"), events.append
            )

        self.assertEqual(client.downloaded, [manual])
        self.assertEqual(result.transcript_language, "vi")
        self.assertEqual(result.origin, "manual_caption")
        self.assertEqual(result.segments[0].text, "Giữ nguyên CLI.")
        self.assertEqual(
            [event["phase"] for event in events if event["type"] == "phase_changed"],
            ["resolving_source", "fetching_subtitles"],
        )

    def test_manual_english_beats_automatic_english(self) -> None:
        manual = CaptionTrack(language="en-US", automatic=False, extension="vtt")
        automatic = CaptionTrack(language="en", automatic=True, extension="vtt")
        client = FakeYoutubeClient(
            YoutubeVideo(
                video_id="abc123def45",
                title="Deploy safely",
                is_live=False,
                subtitles={"en-US": (manual,)},
                automatic_captions={"en": (automatic,)},
            ),
            "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nDeploy safely.\n",
        )
        with tempfile.TemporaryDirectory() as directory:
            result = YoutubeSourceResolver(client).resolve_caption(
                youtube_request(Path(directory), "en"), lambda _event: None
            )

        self.assertEqual(client.downloaded, [manual])
        self.assertEqual(result.transcript_language, "en")

    def test_auto_never_downloads_english_caption_before_language_detection(self) -> None:
        client = FakeYoutubeClient(
            YoutubeVideo(
                video_id="abc123def45",
                title="English title",
                is_live=False,
                subtitles={"en": (CaptionTrack(language="en", automatic=False, extension="vtt"),)},
                automatic_captions={},
            ),
            "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n",
        )
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(WorkerError, "Choose Vietnamese or English") as raised:
                YoutubeSourceResolver(client).resolve_caption(
                    youtube_request(Path(directory), "auto"), lambda _event: None
                )

        self.assertEqual(raised.exception.code, "SOURCE_LANGUAGE_UNDETERMINED")
        self.assertEqual(client.downloaded, [])

    def test_sanitizes_title_and_preserves_video_identity(self) -> None:
        self.assertEqual(
            sanitize_output_stem("  Đừng dùng / private: API?  ", "abc123def45"),
            "Đừng dùng private API-abc123def45",
        )

    def test_missing_caption_uses_guarded_audio_once(self) -> None:
        client = FakeYoutubeClient(
            YoutubeVideo(
                video_id="abc123def45",
                title="Không có caption",
                is_live=False,
                subtitles={},
                automatic_captions={},
                duration_seconds=60,
            ),
            "",
        )

        class FakeAudioEngine:
            def __init__(self) -> None:
                self.calls: list[tuple[str, str]] = []

            def transcribe_youtube_audio(self, _request, _path, *, source_language, emit):
                self.calls.append((source_language, "transcribe"))
                emit({"type": "progress", "jobId": "job_01", "phase": "transcribing", "percent": 90.0})
                return [Segment(id=0, start=0.0, end=1.0, text="Nội dung Việt")], "vi", "whisper_transcribe"

        engine = FakeAudioEngine()
        with tempfile.TemporaryDirectory() as directory:
            result = YoutubeSourceResolver(client).resolve_audio(
                youtube_request(Path(directory), "vi"), engine, lambda _event: None
            )

        self.assertEqual(engine.calls, [("vi", "transcribe")])
        self.assertEqual(result.transcript_language, "vi")
        self.assertEqual(result.origin, "whisper_transcribe")

    def test_duration_guard_rejects_before_audio_download(self) -> None:
        client = FakeYoutubeClient(
            YoutubeVideo(
                video_id="abc123def45",
                title="Quá dài",
                is_live=False,
                subtitles={},
                automatic_captions={},
                duration_seconds=4 * 60 * 60 + 1,
            ),
            "",
        )

        class FailingAudioEngine:
            def transcribe_youtube_audio(self, *_args, **_kwargs):
                raise AssertionError("Audio must not be transcribed after a guard rejection")

        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(WorkerError, "four-hour") as raised:
                YoutubeSourceResolver(client).resolve_audio(
                    youtube_request(Path(directory), "vi"), FailingAudioEngine(), lambda _event: None
                )

        self.assertEqual(raised.exception.code, "YOUTUBE_DURATION_EXCEEDED")

    def test_disk_guard_rejects_before_audio_download(self) -> None:
        class NoAudioDownloadClient(FakeYoutubeClient):
            def download_audio(self, *_args):
                raise AssertionError("Audio download must not start when disk guard fails")

        client = NoAudioDownloadClient(
            YoutubeVideo(
                video_id="abc123def45",
                title="Thiếu dung lượng",
                is_live=False,
                subtitles={},
                automatic_captions={},
                duration_seconds=60,
            ),
            "",
        )

        with tempfile.TemporaryDirectory() as directory:
            with (
                patch(
                    "worker.whispersub_worker.youtube.shutil.disk_usage",
                    return_value=SimpleNamespace(free=0),
                ),
                self.assertRaisesRegex(WorkerError, "Not enough free disk") as raised,
            ):
                YoutubeSourceResolver(client).resolve_audio(
                    youtube_request(Path(directory), "vi"), object(), lambda _event: None
                )

        self.assertEqual(raised.exception.code, "YOUTUBE_DISK_INSUFFICIENT")

    def test_automatic_english_caption_is_used_when_manual_is_absent(self) -> None:
        automatic = CaptionTrack(language="en", automatic=True, extension="vtt")
        client = FakeYoutubeClient(
            YoutubeVideo(
                video_id="abc123def45",
                title="Automatic English",
                is_live=False,
                subtitles={},
                automatic_captions={"en": (automatic,)},
            ),
            "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nAutomatic text\n",
        )
        with tempfile.TemporaryDirectory() as directory:
            result = YoutubeSourceResolver(client).resolve_caption(
                youtube_request(Path(directory), "en"), lambda _event: None
            )

        self.assertEqual(client.downloaded, [automatic])
        self.assertEqual(result.origin, "automatic_caption")

    def test_missing_deno_is_reported_only_when_ytdlp_requests_js(self) -> None:
        with patch("worker.whispersub_worker.youtube.shutil.which", return_value=None):
            error = _yt_dlp_runtime_error(RuntimeError("JavaScript runtime is required"))

        self.assertIsNotNone(error)
        assert error is not None
        self.assertEqual(error.code, "YTDLP_JS_RUNTIME_NOT_READY")
        self.assertIsNone(_yt_dlp_runtime_error(RuntimeError("unrelated network failure")))


if __name__ == "__main__":
    unittest.main()
