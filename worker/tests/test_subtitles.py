from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from worker.tests.test_protocol import valid_message, valid_translation_message
from worker.whispersub_worker.engine import Segment
from worker.whispersub_worker.protocol import WorkerError, parse_start_job
from worker.whispersub_worker.subtitles import render_srt, render_vtt, write_outputs


class SubtitleTest(unittest.TestCase):
    def test_renders_srt_and_vtt_timestamps_with_unicode(self) -> None:
        segments = [Segment(id=7, start=1.234, end=3661.009, text="  Xin chào 👋  ")]

        self.assertIn("00:00:01,234 --> 01:01:01,009", render_srt(segments))
        self.assertIn("00:00:01.234 --> 01:01:01.009", render_vtt(segments))
        self.assertIn("Xin chào 👋", render_srt(segments))

    def test_writes_requested_outputs_and_suffixes_as_one_set(self) -> None:
        with tempfile.TemporaryDirectory(prefix="Whisper Sub ") as directory:
            root = Path(directory)
            input_path = root / "Bài học.mp4"
            input_path.write_bytes(b"fixture")
            (root / "Bài học.srt").write_text("existing", encoding="utf-8")
            message = valid_message()
            message["source"] = {"kind": "local_file", "inputPath": str(input_path)}
            message["outputFormats"] = ["srt", "vtt", "json"]

            outputs = write_outputs(
                parse_start_job(message),
                [Segment(id=0, start=0.0, end=1.0, text="Nội dung")],
            )

            self.assertEqual(
                [path.name for path in outputs],
                ["Bài học (1).srt", "Bài học (1).vtt", "Bài học (1).json"],
            )
            payload = json.loads(outputs[-1].read_text(encoding="utf-8"))
            self.assertEqual(payload["segments"][0]["text"], "Nội dung")
            self.assertEqual((root / "Bài học.srt").read_text(encoding="utf-8"), "existing")

    def test_does_not_publish_when_segment_is_invalid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "invalid.mp4"
            input_path.write_bytes(b"fixture")
            message = valid_message()
            message["source"] = {"kind": "local_file", "inputPath": str(input_path)}

            with self.assertRaisesRegex(WorkerError, "Invalid timestamp"):
                write_outputs(
                    parse_start_job(message),
                    [Segment(id=0, start=2.0, end=1.0, text="bad")],
                )

            self.assertFalse((root / "invalid.srt").exists())

    def test_marks_translated_outputs_with_the_target_language(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "lesson.mp4"
            input_path.write_bytes(b"fixture")
            message = valid_translation_message()
            message["source"] = {"kind": "local_file", "inputPath": str(input_path)}

            outputs = write_outputs(
                parse_start_job(message),
                [Segment(id=0, start=0.0, end=1.0, text="Nội dung đã dịch")],
            )

            self.assertEqual(
                [path.name for path in outputs], ["lesson.vi.srt", "lesson.vi.vtt"]
            )

    def test_writes_youtube_output_with_a_resolved_safe_stem(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            message = valid_message()
            message.update(
                {
                      "source": {"kind": "youtube", "url": "https://youtu.be/abc123"},
                      "workspacePath": str(root),
                      "youtubeCachePath": str(root / "cache"),
                      "youtubeLibraryPath": str(root / "library"),
                    "outputLocationMode": "custom_directory",
                    "outputDirectory": str(root),
                    "sourceLanguage": "vi",
                    "targetLanguage": "vi",
                }
            )

            outputs = write_outputs(
                parse_start_job(message),
                [Segment(id=0, start=0.0, end=1.0, text="Nội dung")],
                output_stem="Bài học API-abc123def45.vi",
            )

            self.assertEqual(
                [path.name for path in outputs],
                ["Bài học API-abc123def45.vi.srt", "Bài học API-abc123def45.vi.vtt"],
            )

    def test_reuses_existing_srt_while_writing_only_missing_vtt(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            message = valid_message()
            message.update(
                {
                    "source": {"kind": "youtube", "url": "https://youtu.be/abc123"},
                    "workspacePath": str(root),
                    "youtubeCachePath": str(root / "cache"),
                    "youtubeLibraryPath": str(root / "library"),
                    "outputLocationMode": "custom_directory",
                    "outputDirectory": str(root),
                    "sourceLanguage": "vi",
                    "targetLanguage": "vi",
                }
            )
            existing = root / "Bài học API-abc123def45.vi.srt"
            existing.write_text("existing", encoding="utf-8")

            outputs = write_outputs(
                parse_start_job(message),
                [Segment(id=0, start=0.0, end=1.0, text="Nội dung")],
                output_stem="Bài học API-abc123def45.vi",
                existing_outputs={"srt": existing},
            )

            self.assertEqual(
                [path.name for path in outputs],
                ["Bài học API-abc123def45.vi.srt", "Bài học API-abc123def45.vi.vtt"],
            )
            self.assertEqual(existing.read_text(encoding="utf-8"), "existing")
            self.assertFalse((root / "Bài học API-abc123def45.vi (1).srt").exists())

    def test_rejects_youtube_output_stem_that_escapes_the_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            message = valid_message()
            message.update(
                {
                      "source": {"kind": "youtube", "url": "https://youtu.be/abc123"},
                      "workspacePath": str(root),
                      "youtubeCachePath": str(root / "cache"),
                      "youtubeLibraryPath": str(root / "library"),
                    "outputLocationMode": "custom_directory",
                    "outputDirectory": str(root),
                    "sourceLanguage": "vi",
                    "targetLanguage": "vi",
                }
            )

            with self.assertRaisesRegex(WorkerError, "Resolved output name is invalid"):
                write_outputs(
                    parse_start_job(message),
                    [Segment(id=0, start=0.0, end=1.0, text="Nội dung")],
                    output_stem="../outside.vi",
                )


if __name__ == "__main__":
    unittest.main()
