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
        "translationMode": "none",
        "technicalTranslation": False,
        "glossary": None,
        "providerModel": None,
        "translationConsent": False,
        "device": "auto",
        "outputFormats": ["srt", "vtt", "srt"],
        "overwritePolicy": "suffix",
    }


def valid_translation_message() -> dict[str, object]:
    return {
        **valid_message(),
        "targetLanguage": "vi",
        "translationProvider": "openai_api",
        "translationMode": "technical_context",
        "technicalTranslation": True,
        "glossary": "software-engineering-default",
        "providerModel": "gpt-5.6-luna",
        "providerApiKey": "sk-test-worker-key",
        "providerBaseUrl": "https://api.openai.com/v1",
        "translationConsent": True,
    }


def valid_gemini_translation_message() -> dict[str, object]:
    return {
        **valid_translation_message(),
        "translationProvider": "gemini_api",
        "providerModel": "gemini-3.5-flash",
        "providerApiKey": "test-gemini-worker-key",
        "providerBaseUrl": "https://generativelanguage.googleapis.com",
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

    def test_parses_consented_openai_translation_runtime(self) -> None:
        request = parse_start_job(valid_translation_message())

        self.assertEqual(request.target_language, "vi")
        self.assertEqual(request.translation_provider, "openai_api")
        self.assertEqual(request.provider_model, "gpt-5.6-luna")
        self.assertEqual(request.provider_api_key, "sk-test-worker-key")

    def test_parses_consented_gemini_translation_runtime(self) -> None:
        request = parse_start_job(valid_gemini_translation_message())

        self.assertEqual(request.translation_provider, "gemini_api")
        self.assertEqual(request.provider_model, "gemini-3.5-flash")
        self.assertEqual(request.provider_api_key, "test-gemini-worker-key")

    def test_rejects_translation_without_explicit_consent(self) -> None:
        message = valid_translation_message()
        message["translationConsent"] = False

        with self.assertRaisesRegex(WorkerError, "consent"):
            parse_start_job(message)

    def test_rejects_runtime_credentials_on_a_local_only_job(self) -> None:
        message = valid_message()
        message["providerApiKey"] = "sk-should-not-be-here"

        with self.assertRaisesRegex(WorkerError, "provider runtime"):
            parse_start_job(message)

    def test_error_event_preserves_code_and_retryability(self) -> None:
        event = WorkerError(
            "MODEL_LOAD_FAILED", "missing model", job_id="job_01", retryable=True
        ).as_event()

        self.assertEqual(event["code"], "MODEL_LOAD_FAILED")
        self.assertTrue(event["retryable"])


if __name__ == "__main__":
    unittest.main()
