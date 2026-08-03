from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from worker.tests.test_protocol import valid_message
from worker.whispersub_worker.engine import Segment
from worker.whispersub_worker.protocol import parse_start_job
from worker.whispersub_worker.youtube import ResolvedTranscript
from worker.whispersub_worker.youtube_cache import YoutubeTranscriptCache


def youtube_request(cache_root: Path, *, model: str = "small"):
    message = valid_message()
    message.update(
        {
            "source": {
                "kind": "youtube",
                "url": "https://www.youtube.com/watch?v=abc123def45&utm_source=test",
            },
            "workspacePath": str(cache_root.parent / "workspace"),
            "youtubeCachePath": str(cache_root),
            "youtubeLibraryPath": str(cache_root.parent / "library"),
            "outputLocationMode": "custom_directory",
            "outputDirectory": str(cache_root.parent / "exports"),
            "sourceLanguage": "vi",
            "targetLanguage": "vi",
            "model": model,
        }
    )
    return parse_start_job(message)


class YoutubeTranscriptCacheTest(unittest.TestCase):
    def test_round_trip_uses_a_hashed_source_key_without_persisting_raw_url(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            cache = YoutubeTranscriptCache(root / "cache")
            request = youtube_request(root / "cache")
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
            output.write_text("1\n00:00:00,000 --> 00:00:01,000\nXin chào\n", encoding="utf-8")

            cache.store(request, resolved, resolved.segments, [output])
            cached = cache.load(request)

            self.assertIsNotNone(cached)
            assert cached is not None
            self.assertEqual(cached.segments[0].text, "Xin chào")
            persisted = "\n".join(
                path.read_text(encoding="utf-8")
                for path in (root / "cache").rglob("*.json")
            )
            self.assertNotIn("https://www.youtube.com", persisted)
            manifest = next((root / "cache").rglob("manifest.json"))
            manifest_payload = json.loads(manifest.read_text(encoding="utf-8"))
            self.assertEqual(manifest_payload["exports"][0]["path"], str(output))

    def test_recipe_change_invalidates_the_cache_entry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            cache = YoutubeTranscriptCache(root / "cache")
            request = youtube_request(root / "cache")
            resolved = ResolvedTranscript(
                segments=[Segment(id=0, start=0.0, end=1.0, text="Xin chào")],
                output_stem="Bai hoc-abc123def45.vi",
                source_language="vi",
                transcript_language="vi",
                origin="manual_caption",
                display_title="Bai hoc",
            )
            cache.store(request, resolved, resolved.segments, [])

            self.assertIsNone(
                cache.load(youtube_request(root / "cache", model="medium"))
            )

    def test_reuses_verified_canonical_export_before_a_suffixed_duplicate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            cache = YoutubeTranscriptCache(root / "cache")
            request = youtube_request(root / "cache")
            resolved = ResolvedTranscript(
                segments=[Segment(id=0, start=0.0, end=1.0, text="Xin chào")],
                output_stem="Bai hoc-abc123def45.vi",
                source_language="vi",
                transcript_language="vi",
                origin="manual_caption",
                display_title="Bai hoc",
            )
            canonical = root / "exports" / "Bai hoc-abc123def45.vi.srt"
            duplicate = root / "exports" / "Bai hoc-abc123def45.vi (1).srt"
            canonical.parent.mkdir(parents=True)
            canonical.write_text("same subtitle", encoding="utf-8")
            duplicate.write_text("same subtitle", encoding="utf-8")
            cache.store(
                request,
                resolved,
                resolved.segments,
                [duplicate, canonical],
            )

            reusable = cache.reusable_outputs(request, resolved.output_stem)

            self.assertEqual(reusable["srt"], canonical)
            self.assertNotIn("vtt", reusable)

            canonical.write_text("tampered", encoding="utf-8")
            self.assertEqual(
                cache.reusable_outputs(request, resolved.output_stem)["srt"],
                duplicate,
            )

    def test_corrupt_transcript_is_treated_as_a_cache_miss(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            cache = YoutubeTranscriptCache(root / "cache")
            request = youtube_request(root / "cache")
            resolved = ResolvedTranscript(
                segments=[Segment(id=0, start=0.0, end=1.0, text="Xin chào")],
                output_stem="Bai hoc-abc123def45.vi",
                source_language="vi",
                transcript_language="vi",
                origin="manual_caption",
                display_title="Bai hoc",
            )
            cache.store(request, resolved, resolved.segments, [])
            transcript = next((root / "cache").rglob("transcript.json"))
            transcript.write_text("{}", encoding="utf-8")

            self.assertIsNone(cache.load(request))


if __name__ == "__main__":
    unittest.main()
