from __future__ import annotations

import importlib.util
import io
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from worker.whispersub_worker.youtube import YoutubeVideo

SMOKE_PATH = Path(__file__).parents[1] / "scripts" / "youtube_smoke.py"
SPEC = importlib.util.spec_from_file_location("youtube_smoke", SMOKE_PATH)
assert SPEC is not None and SPEC.loader is not None
smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smoke)


class YoutubeSmokeTest(unittest.TestCase):
    def test_skips_without_the_explicit_opt_in_url(self) -> None:
        output = io.StringIO()
        with redirect_stdout(output):
            status = smoke.main(environment={}, inspect=lambda _url: self.fail("must not inspect"))

        self.assertEqual(status, 0)
        self.assertIn('"outcome": "skipped"', output.getvalue())

    def test_reports_metadata_without_echoing_the_url_or_title(self) -> None:
        video = YoutubeVideo(
            video_id="abc123def45",
            title="Private fixture title",
            is_live=False,
            subtitles={},
            automatic_captions={},
            duration_seconds=60,
        )
        output = io.StringIO()
        with redirect_stdout(output):
            status = smoke.main(
                environment={"WHISPERSUB_YOUTUBE_SMOKE_URL": "https://youtu.be/secret"},
                inspect=lambda _url: video,
            )

        self.assertEqual(status, 0)
        self.assertIn('"outcome": "metadata_ok"', output.getvalue())
        self.assertNotIn("secret", output.getvalue())
        self.assertNotIn("Private fixture title", output.getvalue())


if __name__ == "__main__":
    unittest.main()
