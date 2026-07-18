from __future__ import annotations

import json
import unittest
from urllib.request import Request

from worker.tests.test_protocol import valid_gemini_translation_message
from worker.whispersub_worker.engine import Segment
from worker.whispersub_worker.gemini_provider import GeminiTranslationAdapter
from worker.whispersub_worker.protocol import WorkerError, parse_start_job
from worker.whispersub_worker.provider_http import HttpResponse


def response_for(translations: list[dict[str, object]]) -> HttpResponse:
    structured = json.dumps({"segments": translations}, ensure_ascii=False)
    body = {
        "candidates": [
            {
                "finishReason": "STOP",
                "content": {"parts": [{"text": structured}]},
            }
        ]
    }
    return HttpResponse(200, {}, json.dumps(body).encode())


class GeminiTranslationAdapterTest(unittest.TestCase):
    def setUp(self) -> None:
        self.request = parse_start_job(valid_gemini_translation_message())
        self.segments = [
            Segment(id=7, start=1.25, end=2.5, text="Deploy the API"),
            Segment(id=8, start=2.5, end=4.0, text="Run pnpm check"),
        ]

    def test_sends_only_segment_ids_and_text_with_structured_output(self) -> None:
        captured: list[Request] = []

        def transport(request: Request, _timeout: float) -> HttpResponse:
            captured.append(request)
            return response_for(
                [
                    {"id": 7, "text": "Triển khai API"},
                    {"id": 8, "text": "Chạy pnpm check"},
                ]
            )

        translated = GeminiTranslationAdapter(transport=transport).translate(
            self.request, self.segments
        )

        self.assertEqual([item.text for item in translated], ["Triển khai API", "Chạy pnpm check"])
        self.assertEqual(translated[0].start, 1.25)
        self.assertEqual(translated[1].end, 4.0)
        self.assertEqual(
            captured[0].full_url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
        )
        payload = json.loads(captured[0].data or b"{}")
        provider_input = json.loads(payload["contents"][0]["parts"][0]["text"])
        self.assertEqual(
            provider_input,
            {
                "targetLanguage": "vi",
                "segments": [
                    {"id": 7, "text": "Deploy the API"},
                    {"id": 8, "text": "Run pnpm check"},
                ],
            },
        )
        self.assertEqual(payload["generationConfig"]["responseMimeType"], "application/json")
        self.assertFalse(
            payload["generationConfig"]["responseJsonSchema"]["additionalProperties"]
        )
        serialized_payload = json.dumps(payload)
        self.assertNotIn("inputPath", serialized_payload)
        self.assertNotIn("start", serialized_payload)
        self.assertNotIn("end", serialized_payload)
        self.assertNotIn("test-gemini-worker-key", serialized_payload)
        self.assertEqual(
            captured[0].get_header("X-goog-api-key"), "test-gemini-worker-key"
        )

    def test_retries_resource_exhausted_with_bounded_backoff(self) -> None:
        attempts = 0
        sleeps: list[float] = []

        def transport(_request: Request, _timeout: float) -> HttpResponse:
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                return HttpResponse(
                    429,
                    {"Retry-After": "0.2"},
                    b'{"error":{"status":"RESOURCE_EXHAUSTED"}}',
                )
            return response_for(
                [
                    {"id": 7, "text": "Triển khai API"},
                    {"id": 8, "text": "Chạy pnpm check"},
                ]
            )

        translated = GeminiTranslationAdapter(
            transport=transport,
            sleep=sleeps.append,
            random_value=lambda: 0.0,
        ).translate(self.request, self.segments)

        self.assertEqual(attempts, 3)
        self.assertEqual(len(sleeps), 2)
        self.assertTrue(all(0 < delay <= 8 for delay in sleeps))
        self.assertEqual(translated[0].text, "Triển khai API")

    def test_reports_quota_or_rate_limit_after_bounded_retries(self) -> None:
        attempts = 0

        def transport(_request: Request, _timeout: float) -> HttpResponse:
            nonlocal attempts
            attempts += 1
            return HttpResponse(
                429,
                {},
                b'{"error":{"status":"RESOURCE_EXHAUSTED"}}',
            )

        with self.assertRaises(WorkerError) as raised:
            GeminiTranslationAdapter(
                transport=transport,
                sleep=lambda _delay: None,
            ).translate(self.request, self.segments)

        self.assertEqual(attempts, 3)
        self.assertEqual(raised.exception.code, "TRANSLATION_QUOTA_OR_RATE_LIMIT")
        self.assertTrue(raised.exception.retryable)

    def test_rejects_missing_or_unexpected_segment_ids(self) -> None:
        adapter = GeminiTranslationAdapter(
            transport=lambda _request, _timeout: response_for(
                [{"id": 7, "text": "Triển khai API"}, {"id": 99, "text": "Sai"}]
            )
        )

        with self.assertRaises(WorkerError) as raised:
            adapter.translate(self.request, self.segments)

        self.assertEqual(raised.exception.code, "TRANSLATION_INVALID_RESPONSE")

    def test_rejects_blocked_content_without_publishing_translation(self) -> None:
        blocked = HttpResponse(
            200,
            {},
            b'{"promptFeedback":{"blockReason":"SAFETY"}}',
        )
        with self.assertRaises(WorkerError) as raised:
            GeminiTranslationAdapter(
                transport=lambda _request, _timeout: blocked
            ).translate(self.request, self.segments)

        self.assertEqual(raised.exception.code, "TRANSLATION_REFUSED")


if __name__ == "__main__":
    unittest.main()
