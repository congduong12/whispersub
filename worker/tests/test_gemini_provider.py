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
        segments_schema = payload["generationConfig"]["responseJsonSchema"]["properties"][
            "segments"
        ]
        self.assertEqual(segments_schema["minItems"], 2)
        self.assertEqual(segments_schema["maxItems"], 2)
        item_properties = segments_schema["items"]["properties"]
        self.assertEqual(item_properties["id"]["enum"], [7, 8])
        self.assertIn("submitted", item_properties["id"]["description"])
        self.assertIn("translated", item_properties["text"]["description"])
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
            diagnostic=lambda _diagnostic: None,
        ).translate(self.request, self.segments)

        self.assertEqual(attempts, 3)
        self.assertEqual(len(sleeps), 2)
        self.assertTrue(all(0 < delay <= 8 for delay in sleeps))
        self.assertEqual(translated[0].text, "Triển khai API")

    def test_retries_invalid_success_response_within_batch_attempt_budget(self) -> None:
        attempts = 0
        sleeps: list[float] = []

        def transport(_request: Request, _timeout: float) -> HttpResponse:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return response_for(
                    [{"id": 7, "text": "Triển khai API"}, {"id": 99, "text": "Sai"}]
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
            diagnostic=lambda _diagnostic: None,
        ).translate(self.request, self.segments)

        self.assertEqual(attempts, 2)
        self.assertEqual(len(sleeps), 1)
        self.assertEqual([segment.id for segment in translated], [7, 8])

    def test_reports_invalid_response_with_redacted_diagnostic(self) -> None:
        diagnostics: list[dict[str, object]] = []
        raw_sentinel = "RAW_SECRET_TRANSCRIPT_/Users/private/video.mp4"
        responses = iter(
            [
                HttpResponse(200, {}, raw_sentinel.encode()),
                response_for(
                    [
                        {"id": 7, "text": "Triển khai API"},
                        {"id": 8, "text": "Chạy pnpm check"},
                    ]
                ),
            ]
        )

        GeminiTranslationAdapter(
            transport=lambda _request, _timeout: next(responses),
            sleep=lambda _delay: None,
            diagnostic=diagnostics.append,
        ).translate(self.request, self.segments)

        self.assertEqual(len(diagnostics), 1)
        self.assertEqual(diagnostics[0]["event"], "gemini_invalid_response")
        self.assertEqual(diagnostics[0]["reason"], "invalid_response_json")
        self.assertEqual(diagnostics[0]["attempt"], 1)
        self.assertEqual(diagnostics[0]["maxAttempts"], 3)
        serialized = json.dumps(diagnostics, ensure_ascii=False)
        self.assertNotIn(raw_sentinel, serialized)
        self.assertNotIn("test-gemini-worker-key", serialized)

    def test_exhausts_invalid_responses_after_three_total_provider_calls(self) -> None:
        attempts = 0
        diagnostics: list[dict[str, object]] = []

        def transport(_request: Request, _timeout: float) -> HttpResponse:
            nonlocal attempts
            attempts += 1
            return response_for(
                [{"id": 7, "text": "Triển khai API"}, {"id": 99, "text": "Sai"}]
            )

        with self.assertRaises(WorkerError) as raised:
            GeminiTranslationAdapter(
                transport=transport,
                sleep=lambda _delay: None,
                diagnostic=diagnostics.append,
            ).translate(self.request, self.segments)

        self.assertEqual(attempts, 3)
        self.assertEqual([item["attempt"] for item in diagnostics], [1, 2, 3])
        self.assertEqual(raised.exception.code, "TRANSLATION_INVALID_RESPONSE")
        self.assertTrue(raised.exception.retryable)
        self.assertIn("id_set_mismatch", str(raised.exception))
        self.assertIn("batch 1/1", str(raised.exception))

    def test_shares_attempt_budget_between_http_and_invalid_response_retries(self) -> None:
        diagnostics: list[dict[str, object]] = []
        sleeps: list[float] = []
        responses = iter(
            [
                HttpResponse(429, {}, b'{"error":{"status":"RESOURCE_EXHAUSTED"}}'),
                response_for(
                    [{"id": 7, "text": "Triển khai API"}, {"id": 99, "text": "Sai"}]
                ),
                response_for(
                    [
                        {"id": 7, "text": "Triển khai API"},
                        {"id": 8, "text": "Chạy pnpm check"},
                    ]
                ),
            ]
        )
        calls = 0

        def transport(_request: Request, _timeout: float) -> HttpResponse:
            nonlocal calls
            calls += 1
            return next(responses)

        translated = GeminiTranslationAdapter(
            transport=transport,
            sleep=sleeps.append,
            random_value=lambda: 0.0,
            diagnostic=diagnostics.append,
        ).translate(self.request, self.segments)

        self.assertEqual(calls, 3)
        self.assertEqual(len(sleeps), 2)
        self.assertEqual([item["attempt"] for item in diagnostics], [2])
        self.assertEqual([segment.id for segment in translated], [7, 8])

    def test_retries_only_the_failed_batch_and_reports_its_index(self) -> None:
        diagnostics: list[dict[str, object]] = []
        responses = iter(
            [
                response_for([{"id": 7, "text": "Triển khai API"}]),
                response_for([{"id": 99, "text": "Sai"}]),
                response_for([{"id": 8, "text": "Chạy pnpm check"}]),
            ]
        )
        calls = 0

        def transport(_request: Request, _timeout: float) -> HttpResponse:
            nonlocal calls
            calls += 1
            return next(responses)

        translated = GeminiTranslationAdapter(
            transport=transport,
            sleep=lambda _delay: None,
            max_batch_segments=1,
            diagnostic=diagnostics.append,
        ).translate(self.request, self.segments)

        self.assertEqual(calls, 3)
        self.assertEqual([segment.id for segment in translated], [7, 8])
        self.assertEqual(diagnostics[0]["batchIndex"], 2)
        self.assertEqual(diagnostics[0]["batchCount"], 2)
        self.assertEqual(diagnostics[0]["attempt"], 1)

    def test_reports_allowlisted_finish_reason_and_provider_metadata(self) -> None:
        diagnostics: list[dict[str, object]] = []
        responses = iter(
            [
                HttpResponse(
                    200,
                    {},
                    json.dumps(
                        {
                            "responseId": "response-123",
                            "modelVersion": "gemini-3.1-flash-lite-2026-05",
                            "usageMetadata": {
                                "promptTokenCount": 120,
                                "totalTokenCount": 245,
                                "unsafeProviderField": "RAW_TRANSCRIPT_SHOULD_NOT_APPEAR",
                            },
                            "candidates": [{"finishReason": "MAX_TOKENS"}],
                        }
                    ).encode(),
                ),
                response_for(
                    [
                        {"id": 7, "text": "Triển khai API"},
                        {"id": 8, "text": "Chạy pnpm check"},
                    ]
                ),
            ]
        )

        GeminiTranslationAdapter(
            transport=lambda _request, _timeout: next(responses),
            sleep=lambda _delay: None,
            diagnostic=diagnostics.append,
        ).translate(self.request, self.segments)

        self.assertEqual(diagnostics[0]["reason"], "finish_max_tokens")
        self.assertEqual(diagnostics[0]["finishReason"], "MAX_TOKENS")
        self.assertEqual(diagnostics[0]["responseId"], "response-123")
        self.assertEqual(
            diagnostics[0]["modelVersion"], "gemini-3.1-flash-lite-2026-05"
        )
        self.assertEqual(
            diagnostics[0]["tokenUsage"],
            {"promptTokenCount": 120, "totalTokenCount": 245},
        )
        self.assertNotIn("RAW_TRANSCRIPT_SHOULD_NOT_APPEAR", json.dumps(diagnostics))

    def test_ignores_thought_parts_when_parsing_structured_translation(self) -> None:
        structured = json.dumps(
            {
                "segments": [
                    {"id": 7, "text": "Triển khai API"},
                    {"id": 8, "text": "Chạy pnpm check"},
                ]
            }
        )
        body = {
            "candidates": [
                {
                    "finishReason": "STOP",
                    "content": {
                        "parts": [
                            {"thought": True, "text": "THOUGHT_SUMMARY_NOT_JSON"},
                            {"text": structured},
                        ]
                    },
                }
            ]
        }
        calls = 0

        def transport(_request: Request, _timeout: float) -> HttpResponse:
            nonlocal calls
            calls += 1
            return HttpResponse(200, {}, json.dumps(body).encode())

        translated = GeminiTranslationAdapter(transport=transport).translate(
            self.request, self.segments
        )

        self.assertEqual(calls, 1)
        self.assertEqual([segment.id for segment in translated], [7, 8])

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
        diagnostics: list[dict[str, object]] = []
        adapter = GeminiTranslationAdapter(
            transport=lambda _request, _timeout: response_for(
                [{"id": 7, "text": "Triển khai API"}, {"id": 99, "text": "Sai"}]
            ),
            sleep=lambda _delay: None,
            diagnostic=diagnostics.append,
        )

        with self.assertRaises(WorkerError) as raised:
            adapter.translate(self.request, self.segments)

        self.assertEqual(raised.exception.code, "TRANSLATION_INVALID_RESPONSE")
        self.assertEqual(len(diagnostics), 3)
        self.assertTrue(all(item["reason"] == "id_set_mismatch" for item in diagnostics))
        self.assertEqual(diagnostics[0]["expectedCount"], 2)
        self.assertEqual(diagnostics[0]["actualCount"], 2)
        self.assertEqual(diagnostics[0]["missingIdCount"], 1)
        self.assertEqual(diagnostics[0]["unexpectedIdCount"], 1)

    def test_rejects_blocked_content_without_publishing_translation(self) -> None:
        blocked = HttpResponse(
            200,
            {},
            b'{"promptFeedback":{"blockReason":"SAFETY"}}',
        )
        calls = 0
        sleeps: list[float] = []
        diagnostics: list[dict[str, object]] = []

        def transport(_request: Request, _timeout: float) -> HttpResponse:
            nonlocal calls
            calls += 1
            return blocked

        with self.assertRaises(WorkerError) as raised:
            GeminiTranslationAdapter(
                transport=transport,
                sleep=sleeps.append,
                diagnostic=diagnostics.append,
            ).translate(self.request, self.segments)

        self.assertEqual(raised.exception.code, "TRANSLATION_REFUSED")
        self.assertEqual(calls, 1)
        self.assertEqual(sleeps, [])
        self.assertEqual(diagnostics, [])


if __name__ == "__main__":
    unittest.main()
