from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Protocol

from worker.whispersub_worker.protocol import StartJobRequest


@dataclass(frozen=True)
class Segment:
    id: int
    start: float
    end: float
    text: str


EventCallback = Callable[[dict[str, object]], None]


class TranscriptionEngine(Protocol):
    def transcribe(
        self, request: StartJobRequest, emit: EventCallback
    ) -> list[Segment]: ...
