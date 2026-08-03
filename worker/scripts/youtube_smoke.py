"""Opt-in, metadata-only YouTube smoke harness.

Run with `WHISPERSUB_YOUTUBE_SMOKE_URL=https://... worker/.venv/bin/python
worker/scripts/youtube_smoke.py`. It never downloads media or calls a provider.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Callable

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from worker.whispersub_worker.protocol import WorkerError
from worker.whispersub_worker.youtube import YoutubeDlClient, YoutubeVideo


def main(
    environment: Mapping[str, str] = os.environ,
    inspect: Callable[[str], YoutubeVideo] | None = None,
) -> int:
    url = environment.get("WHISPERSUB_YOUTUBE_SMOKE_URL", "").strip()
    if not url:
        print(json.dumps({"outcome": "skipped", "reason": "WHISPERSUB_YOUTUBE_SMOKE_URL is not set"}))
        return 0
    try:
        video = (inspect or YoutubeDlClient().inspect)(url)
    except WorkerError as error:
        print(json.dumps({"outcome": "failed", "code": error.code}))
        return 1
    print(
        json.dumps(
            {
                "outcome": "metadata_ok",
                "hasDuration": video.duration_seconds is not None,
                "manualCaptionLanguages": len(video.subtitles),
                "automaticCaptionLanguages": len(video.automatic_captions),
                "isLive": video.is_live,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
