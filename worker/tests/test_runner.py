from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from worker.tests.test_protocol import (
    valid_gemini_translation_message,
    valid_message,
    valid_translation_message,
)
from worker.whispersub_worker.engine import Segment
from worker.whispersub_worker.gemini_provider import GeminiTranslationAdapter
from worker.whispersub_worker.protocol import WorkerError, parse_start_job
from worker.whispersub_worker.provider_http import HttpResponse
from worker.whispersub_worker.runner import run_job
from worker.whispersub_worker.youtube import ResolvedTranscript
from worker.whispersub_worker.youtube_cache import YoutubeTranscriptCache


class FakeEngine:
    def transcribe(self, request, emit):
        emit(
            {
                "type": "progress",
                "jobId": request.job_id,
                "phase": "transcribing",
                "percent": 80.0,
            }
        )
        return [Segment(id=0, start=0.0, end=1.25, text="Xin chào")]


class RunnerTest(unittest.TestCase):
    def youtube_cache_path(self) -> str:
        path = Path(tempfile.mkdtemp(prefix="whispersub-runner-cache-"))
        self.addCleanup(shutil.rmtree, path, True)
        return str(path)

    def test_youtube_vietnamese_caption_bypasses_whisper_and_translation(self) -> None:
        class FailingEngine:
            def transcribe(self, _request, _emit):
                self.fail("Whisper must not run when a Vietnamese caption exists")

        class FakeResolver:
            def resolve_caption(self, request, emit):
                emit({"type": "phase_changed", "jobId": request.job_id, "phase": "resolving_source"})
                return ResolvedTranscript(
                    segments=[Segment(id=0, start=0.0, end=1.0, text="Giữ nguyên tiếng Việt")],
                    output_stem="Bài học API-abc123def45.vi",
                    source_language="vi",
                    transcript_language="vi",
                    origin="manual_caption",
                )

        message = valid_message()
        message.update(
            {
                "source": {"kind": "youtube", "url": "https://youtu.be/abc123"},
                "sourceLanguage": "vi",
                "targetLanguage": "vi",
                  "outputLocationMode": "custom_directory",
                  "outputDirectory": "/tmp",
                  "youtubeCachePath": self.youtube_cache_path(),
                  "youtubeLibraryPath": str(Path(self.youtube_cache_path()).parent / "library"),
            }
        )
        received: dict[str, object] = {}

        events: list[dict[str, object]] = []
        run_job(
            parse_start_job(message),
            FailingEngine(),
            events.append,
            youtube_resolver=FakeResolver(),
            output_writer=lambda _request, segments, **kwargs: received.update(
                {"text": segments[0].text, **kwargs}
            )
            or [Path("/tmp/Bài học API-abc123def45.vi.srt")],
        )

        self.assertEqual(received, {"text": "Giữ nguyên tiếng Việt", "output_stem": "Bài học API-abc123def45.vi"})
        self.assertIn(
            {
                "type": "source_resolved",
                "jobId": "job_01",
                "displayTitle": "YouTube video",
                  "transcriptOrigin": "manual_caption",
                  "sourceLanguage": "vi",
                  "cacheHit": False,
              },
              events,
          )

    def test_youtube_cache_hit_bypasses_resolver_whisper_and_gemini(self) -> None:
        class FailingEngine:
            def transcribe(self, _request, _emit):
                raise AssertionError("Whisper must not run on an exact cache hit")

        class FailingTranslator:
            def translate(self, _request, _segments):
                raise AssertionError("Gemini must not run on an exact cache hit")

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            message = valid_gemini_translation_message()
            message.update(
                {
                    "source": {
                        "kind": "youtube",
                        "url": "https://youtu.be/abc123def45",
                    },
                    "workspacePath": str(root / "workspace"),
                    "youtubeCachePath": str(root / "cache"),
                    "youtubeLibraryPath": str(root / "library"),
                    "outputLocationMode": "custom_directory",
                    "outputDirectory": str(root),
                    "sourceLanguage": "en",
                    "targetLanguage": "vi",
                }
            )
            request = parse_start_job(message)
            resolved = ResolvedTranscript(
                segments=[Segment(id=0, start=0.0, end=1.0, text="Deploy the API")],
                output_stem="Deploy API-abc123def45.vi",
                source_language="en",
                transcript_language="en",
                origin="manual_caption",
                display_title="Deploy API",
            )
            final_segments = [
                Segment(id=0, start=0.0, end=1.0, text="Triển khai API")
            ]
            YoutubeTranscriptCache(root / "cache").store(
                request, resolved, final_segments, []
            )
            events: list[dict[str, object]] = []
            published: list[Segment] = []

            run_job(
                request,
                FailingEngine(),
                events.append,
                translator=FailingTranslator(),
                output_writer=lambda _request, segments, **_kwargs: published.extend(
                    segments
                )
                or [],
            )

        self.assertEqual(published[0].text, "Triển khai API")
        source_event = next(event for event in events if event["type"] == "source_resolved")
        self.assertTrue(source_event["cacheHit"])
        self.assertEqual(events[-1]["cacheStatus"], "hit")

    def test_youtube_cache_hit_reuses_export_and_backfills_library(self) -> None:
        class FailingEngine:
            def transcribe(self, _request, _emit):
                raise AssertionError("Whisper must not run on an exact cache hit")

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            message = valid_message()
            message.update(
                {
                    "source": {
                        "kind": "youtube",
                        "url": "https://youtu.be/abc123def45",
                    },
                    "workspacePath": str(root / "workspace"),
                    "youtubeCachePath": str(root / "cache"),
                    "youtubeLibraryPath": str(root / "library"),
                    "outputLocationMode": "custom_directory",
                    "outputDirectory": str(root / "exports"),
                    "sourceLanguage": "vi",
                    "targetLanguage": "vi",
                    "outputFormats": ["srt"],
                }
            )
            request = parse_start_job(message)
            resolved = ResolvedTranscript(
                segments=[Segment(id=0, start=0.0, end=1.0, text="Xin chào")],
                output_stem="Bai hoc-abc123def45.vi",
                source_language="vi",
                transcript_language="vi",
                origin="manual_caption",
                display_title="Bai hoc",
            )
            output = root / "exports" / "Bai hoc-abc123def45.vi.srt"
            output.parent.mkdir(parents=True)
            output.write_text("existing subtitle", encoding="utf-8")
            YoutubeTranscriptCache(root / "cache").store(
                request, resolved, resolved.segments, [output]
            )
            events: list[dict[str, object]] = []

            run_job(
                request,
                FailingEngine(),
                events.append,
                output_writer=lambda *_args, **_kwargs: (_ for _ in ()).throw(
                    AssertionError("A verified export must not be written again")
                ),
            )

            self.assertEqual(events[-1]["outputs"], [str(output)])
            self.assertEqual(events[-1]["cacheStatus"], "hit")
            self.assertEqual(events[-1]["libraryStatus"], "stored")
            self.assertTrue(
                (root / "library/items/abc123def45/manifest.json").is_file()
            )

    def test_youtube_english_caption_resolves_before_gemini_translation(self) -> None:
        order: list[str] = []

        class FailingEngine:
            def transcribe(self, _request, _emit):
                raise AssertionError("Whisper must not run when an English caption exists")

        class FakeResolver:
            def resolve_caption(self, _request, _emit):
                order.append("resolve_caption")
                return ResolvedTranscript(
                    segments=[Segment(id=0, start=0.0, end=1.0, text="Deploy the API")],
                    output_stem="Deploy API-abc123def45.vi",
                    source_language="en",
                    transcript_language="en",
                    origin="manual_caption",
                )

        class FakeTranslator:
            def translate(self, _request, segments):
                order.append("translate")
                if segments[0].text != "Deploy the API":
                    raise AssertionError("Translator received unexpected caption content")
                return [Segment(id=0, start=0.0, end=1.0, text="Triển khai API")]

        message = valid_gemini_translation_message()
        message.update(
            {
                "source": {"kind": "youtube", "url": "https://youtu.be/abc123"},
                "sourceLanguage": "en",
                "targetLanguage": "vi",
                  "outputLocationMode": "custom_directory",
                  "outputDirectory": "/tmp",
                  "youtubeCachePath": self.youtube_cache_path(),
                  "youtubeLibraryPath": str(Path(self.youtube_cache_path()).parent / "library"),
            }
        )
        published: list[Segment] = []

        run_job(
            parse_start_job(message),
            FailingEngine(),
            lambda _event: None,
            translator=FakeTranslator(),
            readiness_check=lambda _request: order.append("preflight"),
            youtube_resolver=FakeResolver(),
            output_writer=lambda _request, segments, **_kwargs: published.extend(segments) or [],
        )

        self.assertEqual(order, ["resolve_caption", "preflight", "translate"])
        self.assertEqual(published[0].text, "Triển khai API")

    def test_caption_unavailable_falls_back_to_audio_once(self) -> None:
        class FailingEngine:
            def transcribe(self, _request, _emit):
                raise AssertionError("YouTube fallback must use the resolver audio path")

        class FakeResolver:
            def __init__(self) -> None:
                self.caption_calls = 0
                self.audio_calls = 0

            def resolve_caption(self, request, _emit):
                self.caption_calls += 1
                raise WorkerError("YOUTUBE_CAPTION_UNAVAILABLE", "missing", job_id=request.job_id)

            def resolve_audio(self, _request, _engine, _emit):
                self.audio_calls += 1
                return ResolvedTranscript(
                    segments=[Segment(id=0, start=0.0, end=1.0, text="Tiếng Việt")],
                    output_stem="fallback-abc123def45.vi",
                    source_language="vi",
                    transcript_language="vi",
                    origin="whisper_transcribe",
                )

        resolver = FakeResolver()
        message = valid_message()
        message.update(
            {
                "source": {"kind": "youtube", "url": "https://youtu.be/abc123"},
                "sourceLanguage": "vi",
                "targetLanguage": "vi",
                  "outputLocationMode": "custom_directory",
                  "outputDirectory": "/tmp",
                  "youtubeCachePath": self.youtube_cache_path(),
                  "youtubeLibraryPath": str(Path(self.youtube_cache_path()).parent / "library"),
            }
        )
        run_job(
            parse_start_job(message),
            FailingEngine(),
            lambda _event: None,
            youtube_resolver=resolver,
            output_writer=lambda _request, _segments, **_kwargs: [],
        )

        self.assertEqual((resolver.caption_calls, resolver.audio_calls), (1, 1))

    def test_caption_fetch_failure_bubbles_without_audio_fallback(self) -> None:
        class FakeResolver:
            def __init__(self) -> None:
                self.audio_calls = 0

            def resolve_caption(self, request, _emit):
                raise WorkerError(
                    "YOUTUBE_CAPTION_FETCH_FAILED",
                    "temporary transport failure",
                    job_id=request.job_id,
                    retryable=True,
                )

            def resolve_audio(self, _request, _engine, _emit):
                self.audio_calls += 1
                raise AssertionError("Transport failures must not download audio")

        resolver = FakeResolver()
        message = valid_message()
        message.update(
            {
                "source": {"kind": "youtube", "url": "https://youtu.be/abc123"},
                "sourceLanguage": "vi",
                "targetLanguage": "vi",
                "outputLocationMode": "custom_directory",
                "outputDirectory": "/tmp",
                "youtubeCachePath": self.youtube_cache_path(),
                "youtubeLibraryPath": str(Path(self.youtube_cache_path()).parent / "library"),
            }
        )

        with self.assertRaises(WorkerError) as raised:
            run_job(
                parse_start_job(message),
                FakeEngine(),
                lambda _event: None,
                youtube_resolver=resolver,
                output_writer=lambda _request, _segments, **_kwargs: [],
            )

        self.assertEqual(raised.exception.code, "YOUTUBE_CAPTION_FETCH_FAILED")
        self.assertTrue(raised.exception.retryable)
        self.assertEqual(resolver.audio_calls, 0)

    def test_auto_detected_vietnamese_never_calls_gemini(self) -> None:
        class FailingTranslator:
            def translate(self, _request, _segments):
                raise AssertionError("Detected Vietnamese must not reach Gemini")

        class FakeResolver:
            def resolve_caption(self, _request, _emit):
                raise WorkerError("SOURCE_LANGUAGE_UNDETERMINED", "auto", job_id="job_01")

            def resolve_audio(self, _request, _engine, _emit):
                return ResolvedTranscript(
                    segments=[Segment(id=0, start=0.0, end=1.0, text="Tiếng Việt")],
                    output_stem="auto-abc123def45.vi",
                    source_language="vi",
                    transcript_language="vi",
                    origin="whisper_transcribe",
                )

        message = valid_gemini_translation_message()
        message.update(
            {
                "source": {"kind": "youtube", "url": "https://youtu.be/abc123"},
                "sourceLanguage": "auto",
                "targetLanguage": "vi",
                  "outputLocationMode": "custom_directory",
                  "outputDirectory": "/tmp",
                  "youtubeCachePath": self.youtube_cache_path(),
                  "youtubeLibraryPath": str(Path(self.youtube_cache_path()).parent / "library"),
            }
        )
        run_job(
            parse_start_job(message),
            FakeEngine(),
            lambda _event: None,
            translator=FailingTranslator(),
            youtube_resolver=FakeResolver(),
            output_writer=lambda _request, _segments, **_kwargs: [],
        )

    def test_emits_one_ordered_terminal_event(self) -> None:
        events: list[dict[str, object]] = []
        request = parse_start_job(valid_message())

        run_job(
            request,
            FakeEngine(),
            events.append,
            output_writer=lambda _request, _segments: [Path("/tmp/Bài học.srt")],
        )

        self.assertEqual(events[0], {"type": "job_started", "jobId": "job_01"})
        terminals = [event for event in events if event["type"] in {"completed", "error"}]
        self.assertEqual(len(terminals), 1)
        self.assertEqual(terminals[0]["type"], "completed")

    def test_propagates_stable_worker_errors_without_completed_event(self) -> None:
        class FailingEngine:
            def transcribe(self, request, emit):
                raise WorkerError("FFMPEG_FAILED", "decode failed", job_id=request.job_id)

        events: list[dict[str, object]] = []
        with self.assertRaises(WorkerError):
            run_job(parse_start_job(valid_message()), FailingEngine(), events.append)

        self.assertEqual(events, [{"type": "job_started", "jobId": "job_01"}])

    def test_translates_before_publishing_output(self) -> None:
        class FakeTranslator:
            def translate(self, request, segments):
                self.received = segments
                return [
                    Segment(
                        id=segment.id,
                        start=segment.start,
                        end=segment.end,
                        text="Hello",
                    )
                    for segment in segments
                ]

        events: list[dict[str, object]] = []
        written: list[Segment] = []
        translator = FakeTranslator()

        run_job(
            parse_start_job(valid_translation_message()),
            FakeEngine(),
            events.append,
            translator=translator,
            output_writer=lambda _request, segments: written.extend(segments)
            or [Path("/tmp/Bài học.vi.srt")],
        )

        phases = [event.get("phase") for event in events if event["type"] == "phase_changed"]
        self.assertEqual(phases, ["translating", "writing_output"])
        self.assertEqual(written[0].text, "Hello")
        self.assertEqual(events[-1]["outputs"], ["/tmp/Bài học.vi.srt"])

    def test_runs_readiness_check_before_transcription(self) -> None:
        order: list[str] = []

        class RecordingEngine:
            def transcribe(self, _request, _emit):
                order.append("transcribe")
                return [Segment(id=0, start=0.0, end=1.0, text="Hello")]

        class RecordingTranslator:
            def translate(self, _request, segments):
                order.append("translate")
                return segments

        run_job(
            parse_start_job(valid_translation_message()),
            RecordingEngine(),
            lambda _event: None,
            translator=RecordingTranslator(),
            readiness_check=lambda _request: order.append("preflight"),
            output_writer=lambda _request, _segments: [],
        )

        self.assertEqual(order, ["preflight", "transcribe", "translate"])

    def test_readiness_failure_skips_whisper_translation_and_output(self) -> None:
        engine_called = False
        translator_called = False
        output_called = False

        class RecordingEngine:
            def transcribe(self, _request, _emit):
                nonlocal engine_called
                engine_called = True
                return []

        class RecordingTranslator:
            def translate(self, _request, segments):
                nonlocal translator_called
                translator_called = True
                return segments

        def fail_readiness(request):
            raise WorkerError(
                "OPENAI_BILLING_NOT_READY",
                "billing unavailable",
                job_id=request.job_id,
            )

        def output_writer(_request, _segments):
            nonlocal output_called
            output_called = True
            return []

        with self.assertRaises(WorkerError) as raised:
            run_job(
                parse_start_job(valid_translation_message()),
                RecordingEngine(),
                lambda _event: None,
                translator=RecordingTranslator(),
                readiness_check=fail_readiness,
                output_writer=output_writer,
            )

        self.assertEqual(raised.exception.code, "OPENAI_BILLING_NOT_READY")
        self.assertFalse(engine_called)
        self.assertFalse(translator_called)
        self.assertFalse(output_called)

    def test_does_not_publish_partial_output_when_translation_fails(self) -> None:
        class FailingTranslator:
            def translate(self, request, segments):
                raise WorkerError(
                    "TRANSLATION_RATE_LIMITED",
                    "rate limited",
                    job_id=request.job_id,
                    retryable=True,
                )

        events: list[dict[str, object]] = []
        published = False

        def output_writer(_request, _segments):
            nonlocal published
            published = True
            return []

        with self.assertRaises(WorkerError):
            run_job(
                parse_start_job(valid_translation_message()),
                FakeEngine(),
                events.append,
                translator=FailingTranslator(),
                output_writer=output_writer,
            )

        self.assertFalse(published)
        self.assertNotIn("writing_output", [event.get("phase") for event in events])
        self.assertFalse(any(event["type"] == "completed" for event in events))

    def test_does_not_publish_after_a_later_gemini_batch_exhausts_retries(self) -> None:
        class MultiBatchEngine:
            def transcribe(self, _request, _emit):
                return [
                    Segment(id=7, start=0.0, end=1.0, text="Deploy the API"),
                    Segment(id=8, start=1.0, end=2.0, text="Run pnpm check"),
                ]

        def response_for(segment_id: int, text: str) -> HttpResponse:
            structured = json.dumps(
                {"segments": [{"id": segment_id, "text": text}]},
                ensure_ascii=False,
            )
            body = {
                "candidates": [
                    {
                        "finishReason": "STOP",
                        "content": {"parts": [{"text": structured}]},
                    }
                ]
            }
            return HttpResponse(200, {}, json.dumps(body).encode())

        calls = 0

        def transport(_request, _timeout):
            nonlocal calls
            calls += 1
            if calls == 1:
                return response_for(7, "Triển khai API")
            return response_for(99, "Sai")

        translator = GeminiTranslationAdapter(
            transport=transport,
            sleep=lambda _delay: None,
            max_batch_segments=1,
            diagnostic=lambda _diagnostic: None,
        )
        events: list[dict[str, object]] = []
        published = False

        def output_writer(_request, _segments):
            nonlocal published
            published = True
            return []

        with self.assertRaises(WorkerError) as raised:
            run_job(
                parse_start_job(valid_gemini_translation_message()),
                MultiBatchEngine(),
                events.append,
                translator=translator,
                output_writer=output_writer,
            )

        self.assertEqual(calls, 4)
        self.assertEqual(raised.exception.code, "TRANSLATION_INVALID_RESPONSE")
        self.assertFalse(published)
        self.assertNotIn("writing_output", [event.get("phase") for event in events])
        self.assertFalse(any(event["type"] == "completed" for event in events))


if __name__ == "__main__":
    unittest.main()
