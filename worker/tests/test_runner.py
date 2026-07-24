from __future__ import annotations

import json
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
