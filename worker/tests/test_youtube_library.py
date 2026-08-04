from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from worker.tests.test_youtube_cache import youtube_request
from worker.whispersub_worker.engine import Segment
from worker.whispersub_worker.youtube import ResolvedTranscript
from worker.whispersub_worker.youtube_library import _encode_segments, store_library_item


class YoutubeLibraryTest(unittest.TestCase):
    def test_segment_encoding_is_cross_language_canonical(self) -> None:
        payload = [
            {"id": 0, "start": 0, "end": 1, "text": "Xin chào"},
        ]

        self.assertEqual(
            _encode_segments(payload),
            '[{"id":0,"start":0.0,"end":1.0,"text":"Xin chào"}]'.encode("utf-8"),
        )
        self.assertEqual(
            hashlib.sha256(_encode_segments(payload)).hexdigest(),
            "24c9a39b6cc1ed1335c12a171ae9fd489620c4e1eb37f346652790ebe3eb0616",
        )

    def test_versions_share_one_canonical_video_item_and_exclude_raw_url(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            request = youtube_request(root / "cache")
            resolved = ResolvedTranscript(
                [Segment(0, 0, 1, "Xin chào")],
                "Bai-hoc-abc123def45.vi",
                "vi",
                "vi",
                "manual_caption",
                "Bai hoc",
            )

            store_library_item(request, resolved, resolved.segments, [])
            changed = youtube_request(root / "cache", model="medium")
            store_library_item(changed, resolved, resolved.segments, [])

            manifest = next((root / "library/items").glob("*/manifest.json"))
            value = json.loads(manifest.read_text())

            self.assertEqual(value["videoId"], "abc123def45")
            self.assertEqual(len(value["versions"]), 2)
            self.assertNotIn("https://www.youtube", manifest.read_text())

    def test_corrupt_existing_record_fails_closed_without_overwriting_it(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            request = youtube_request(root / "cache")
            bad = root / "library/items/abc123def45"
            bad.mkdir(parents=True)
            (bad / "manifest.json").write_text("{bad")
            resolved = ResolvedTranscript(
                [Segment(0, 0, 1, "Xin chào")],
                "Bai-hoc-abc123def45.vi",
                "vi",
                "vi",
                "manual_caption",
                "Bai hoc",
            )

            with self.assertRaisesRegex(ValueError, "corrupt"):
                store_library_item(request, resolved, resolved.segments, [])

            self.assertEqual((bad / "manifest.json").read_text(), "{bad")
