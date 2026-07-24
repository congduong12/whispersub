from __future__ import annotations

import json
import unittest
from urllib.request import Request

from worker.tests.test_protocol import valid_translation_message
from worker.whispersub_worker.engine import Segment
from worker.whispersub_worker.openai_provider import HttpResponse, OpenAITranslationAdapter
from worker.whispersub_worker.protocol import WorkerError, parse_start_job


def response_for(translations: list[dict[str, object]]) -> HttpResponse:
    structured = json.dumps({"segments": translations}, ensure_ascii=False)
    body = {
        "status": "completed",
        "output": [
            {
                "type": "message",
                "content": [{"type": "output_text", "text": structured}],
            }
        ],
    }
    return HttpResponse(200, {}, json.dumps(body).encode())


class OpenAITranslationAdapterTest(unittest.TestCase):
    def setUp(self) -> None:
        self.request = parse_start_job(valid_translation_message())
        self.segments = [
            Segment(id=7, start=1.25, end=2.5, text="Deploy the API"),
            Segment(id=8, start=2.5, end=4.0, text="Run pnpm check"),
        ]

    def test_preflight_uses_fixed_synthetic_content_without_user_data(self) -> None:
        captured: list[Request] = []

        def transport(request: Request, _timeout: float) -> HttpResponse:
            captured.append(request)
            return HttpResponse(200, {}, b'{"status":"completed"}')

        OpenAITranslationAdapter(transport=transport).preflight(self.request)

        self.assertEqual(len(captured), 1)
        payload = json.loads(captured[0].data or b"{}")
        self.assertEqual(payload["model"], self.request.provider_model)
        self.assertEqual(
            payload["input"],
            "WhisperSub readiness check. Return the requested JSON only.",
        )
        self.assertFalse(payload["store"])
        self.assertTrue(payload["text"]["format"]["strict"])
        self.assertEqual(payload["max_output_tokens"], 32)
        serialized_payload = json.dumps(payload)
        self.assertNotIn(str(self.request.input_path), serialized_payload)
        self.assertNotIn("Deploy the API", serialized_payload)
        self.assertNotIn("Run pnpm check", serialized_payload)
        self.assertNotIn("sk-test-worker-key", serialized_payload)
        self.assertNotIn("segments", serialized_payload)
        self.assertEqual(
            captured[0].get_header("Authorization"),
            "Bearer sk-test-worker-key",
        )

    def test_preflight_maps_quota_without_retrying_or_exposing_provider_body(self) -> None:
        attempts = 0

        def transport(_request: Request, _timeout: float) -> HttpResponse:
            nonlocal attempts
            attempts += 1
            return HttpResponse(
                429,
                {},
                b'{"error":{"code":"insufficient_quota","message":"secret provider detail"}}',
            )

        with self.assertRaises(WorkerError) as raised:
            OpenAITranslationAdapter(transport=transport).preflight(self.request)

        self.assertEqual(attempts, 1)
        self.assertEqual(raised.exception.code, "OPENAI_BILLING_NOT_READY")
        self.assertIn("Whisper chưa được chạy", str(raised.exception))
        self.assertNotIn("secret provider detail", str(raised.exception))
        self.assertFalse(raised.exception.retryable)

    def test_sends_only_segment_ids_and_text_with_store_disabled(self) -> None:
        captured: list[Request] = []

        def transport(request: Request, _timeout: float) -> HttpResponse:
            captured.append(request)
            return response_for(
                [
                    {"id": 7, "text": "Triển khai API"},
                    {"id": 8, "text": "Chạy pnpm check"},
                ]
            )

        translated = OpenAITranslationAdapter(transport=transport).translate(
            self.request, self.segments
        )

        self.assertEqual([item.text for item in translated], ["Triển khai API", "Chạy pnpm check"])
        self.assertEqual(translated[0].start, 1.25)
        self.assertEqual(translated[1].end, 4.0)
        payload = json.loads(captured[0].data or b"{}")
        provider_input = json.loads(payload["input"])
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
        self.assertFalse(payload["store"])
        self.assertTrue(payload["text"]["format"]["strict"])
        serialized_payload = json.dumps(payload)
        self.assertNotIn("inputPath", serialized_payload)
        self.assertNotIn("start", serialized_payload)
        self.assertNotIn("end", serialized_payload)
        self.assertNotIn("sk-test-worker-key", serialized_payload)
        self.assertEqual(captured[0].get_header("Authorization"), "Bearer sk-test-worker-key")

    def test_retries_rate_limit_with_bounded_backoff(self) -> None:
        attempts = 0
        sleeps: list[float] = []

        def transport(_request: Request, _timeout: float) -> HttpResponse:
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                return HttpResponse(429, {"Retry-After": "0.2"}, b'{"error":{"code":"rate_limit_exceeded"}}')
            return response_for(
                [
                    {"id": 7, "text": "Triển khai API"},
                    {"id": 8, "text": "Chạy pnpm check"},
                ]
            )

        translated = OpenAITranslationAdapter(
            transport=transport,
            sleep=sleeps.append,
            random_value=lambda: 0.0,
        ).translate(self.request, self.segments)

        self.assertEqual(attempts, 3)
        self.assertEqual(len(sleeps), 2)
        self.assertTrue(all(0 < delay <= 8 for delay in sleeps))
        self.assertEqual(translated[0].text, "Triển khai API")

    def test_does_not_retry_exhausted_quota(self) -> None:
        attempts = 0

        def transport(_request: Request, _timeout: float) -> HttpResponse:
            nonlocal attempts
            attempts += 1
            return HttpResponse(429, {}, b'{"error":{"code":"insufficient_quota"}}')

        with self.assertRaises(WorkerError) as raised:
            OpenAITranslationAdapter(transport=transport).translate(self.request, self.segments)

        self.assertEqual(attempts, 1)
        self.assertEqual(raised.exception.code, "TRANSLATION_QUOTA_EXCEEDED")
        self.assertFalse(raised.exception.retryable)

    def test_rejects_missing_or_unexpected_segment_ids(self) -> None:
        adapter = OpenAITranslationAdapter(
            transport=lambda _request, _timeout: response_for(
                [{"id": 7, "text": "Triển khai API"}, {"id": 99, "text": "Sai"}]
            )
        )

        with self.assertRaises(WorkerError) as raised:
            adapter.translate(self.request, self.segments)

        self.assertEqual(raised.exception.code, "TRANSLATION_INVALID_RESPONSE")

    def test_chunks_long_transcripts_and_preserves_segment_order(self) -> None:
        calls = 0

        def transport(request: Request, _timeout: float) -> HttpResponse:
            nonlocal calls
            calls += 1
            payload = json.loads(request.data or b"{}")
            provider_input = json.loads(payload["input"])
            source = provider_input["segments"][0]
            return response_for([{"id": source["id"], "text": f"dịch-{source['id']}"}])

        translated = OpenAITranslationAdapter(
            transport=transport, max_batch_segments=1
        ).translate(self.request, self.segments)

        self.assertEqual(calls, 2)
        self.assertEqual([segment.id for segment in translated], [7, 8])
        self.assertEqual([segment.text for segment in translated], ["dịch-7", "dịch-8"])


if __name__ == "__main__":
    unittest.main()
