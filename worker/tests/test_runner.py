from __future__ import annotations

import unittest
from pathlib import Path

from worker.tests.test_protocol import valid_message
from worker.whispersub_worker.engine import Segment
from worker.whispersub_worker.protocol import WorkerError, parse_start_job
from worker.whispersub_worker.runner import run_job


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


if __name__ == "__main__":
    unittest.main()
