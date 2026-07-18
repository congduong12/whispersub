from __future__ import annotations

from typing import Protocol

from worker.whispersub_worker.engine import Segment
from worker.whispersub_worker.protocol import StartJobRequest


class TranslationProvider(Protocol):
    def translate(
        self, request: StartJobRequest, segments: list[Segment]
    ) -> list[Segment]: ...
