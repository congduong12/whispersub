from __future__ import annotations

import unittest

from worker.whispersub_worker.protocol import (
    WorkerError,
    handle_message,
    parse_start_job,
)


def valid_message() -> dict[str, object]:
    return {
        "type": "start_job",
        "jobId": "job_01",
        "inputPath": "/tmp/Bài học.mp4",
        "outputLocationMode": "same_as_input",
        "outputDirectory": None,
        "model": "small",
        "sourceLanguage": "vi",
        "task": "transcribe",
        "translationProvider": "none",
        "device": "auto",
        "outputFormats": ["srt", "vtt", "srt"],
        "overwritePolicy": "suffix",
    }


class ProtocolTest(unittest.TestCase):
    def test_ping_reports_protocol_version(self) -> None:
        self.assertEqual(
            handle_message({"type": "ping"}),
            [{"type": "pong", "protocolVersion": 1, "worker": "local"}],
        )

    def test_parses_complete_start_job_and_deduplicates_formats(self) -> None:
        request = parse_start_job(valid_message())

        self.assertEqual(request.job_id, "job_01")
        self.assertEqual(str(request.input_path), "/tmp/Bài học.mp4")
        self.assertEqual(request.output_formats, ("srt", "vtt"))

    def test_requires_srt_output(self) -> None:
        message = valid_message()
        message["outputFormats"] = ["vtt"]

        with self.assertRaisesRegex(WorkerError, "SRT output is required"):
            parse_start_job(message)

    def test_rejects_provider_work_in_local_slice(self) -> None:
        message = valid_message()
        message["translationProvider"] = "openai_api"

        with self.assertRaisesRegex(WorkerError, "outside the local worker scope"):
            parse_start_job(message)

    def test_error_event_preserves_code_and_retryability(self) -> None:
        event = WorkerError(
            "MODEL_LOAD_FAILED", "missing model", job_id="job_01", retryable=True
        ).as_event()

        self.assertEqual(event["code"], "MODEL_LOAD_FAILED")
        self.assertTrue(event["retryable"])


if __name__ == "__main__":
    unittest.main()
