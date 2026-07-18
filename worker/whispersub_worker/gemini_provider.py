from __future__ import annotations

import ipaddress
import json
import time
from collections.abc import Callable
from random import random
from typing import Any
from urllib.error import URLError
from urllib.parse import quote, urlsplit, urlunsplit
from urllib.request import Request

from worker.whispersub_worker.engine import Segment
from worker.whispersub_worker.protocol import StartJobRequest, WorkerError
from worker.whispersub_worker.provider_http import (
    HttpResponse,
    ProviderTransportError,
    Transport,
    default_transport,
    header,
)

MAX_BATCH_SEGMENTS = 50
MAX_BATCH_CHARACTERS = 12_000
MAX_ATTEMPTS = 3
MAX_RETRY_DELAY_SECONDS = 8.0
REQUEST_TIMEOUT_SECONDS = 30.0
RETRYABLE_STATUSES = {408, 429, 500, 502, 503, 504}
REFUSAL_REASONS = {
    "BLOCKLIST",
    "IMAGE_SAFETY",
    "OTHER",
    "PROHIBITED_CONTENT",
    "RECITATION",
    "SAFETY",
    "SPII",
}


class GeminiTranslationAdapter:
    def __init__(
        self,
        *,
        transport: Transport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        random_value: Callable[[], float] = random,
        max_attempts: int = MAX_ATTEMPTS,
        max_batch_segments: int = MAX_BATCH_SEGMENTS,
        max_batch_characters: int = MAX_BATCH_CHARACTERS,
        timeout_seconds: float = REQUEST_TIMEOUT_SECONDS,
    ) -> None:
        if max_attempts < 1 or max_batch_segments < 1 or max_batch_characters < 1:
            raise ValueError("Translation limits must be positive")
        self._transport = transport or default_transport
        self._sleep = sleep
        self._random_value = random_value
        self._max_attempts = max_attempts
        self._max_batch_segments = max_batch_segments
        self._max_batch_characters = max_batch_characters
        self._timeout_seconds = timeout_seconds

    def translate(
        self, request: StartJobRequest, segments: list[Segment]
    ) -> list[Segment]:
        if request.translation_provider != "gemini_api":
            raise WorkerError(
                "INVALID_REQUEST",
                "Gemini adapter received a different provider",
                job_id=request.job_id,
            )
        if not segments:
            return []

        translated: list[Segment] = []
        for batch in _chunk_segments(
            segments,
            max_segments=self._max_batch_segments,
            max_characters=self._max_batch_characters,
        ):
            translated.extend(self._translate_batch(request, batch))
        return translated

    def _translate_batch(
        self, request: StartJobRequest, segments: list[Segment]
    ) -> list[Segment]:
        provider_request = self._build_request(request, segments)
        response = self._execute_with_retry(provider_request, request.job_id)
        return _parse_translations(response.body, request.job_id, segments)

    def _build_request(
        self, request: StartJobRequest, segments: list[Segment]
    ) -> Request:
        api_key = request.provider_api_key
        base_url = request.provider_base_url
        model = request.provider_model
        if not api_key or not base_url or not model:
            raise WorkerError(
                "INVALID_REQUEST",
                "Gemini runtime configuration is incomplete",
                job_id=request.job_id,
            )
        target_name = "Vietnamese" if request.target_language == "vi" else "English"
        provider_input = {
            "targetLanguage": request.target_language,
            "segments": [{"id": segment.id, "text": segment.text} for segment in segments],
        }
        schema = {
            "type": "object",
            "properties": {
                "segments": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "integer"},
                            "text": {"type": "string"},
                        },
                        "required": ["id", "text"],
                        "additionalProperties": False,
                    },
                }
            },
            "required": ["segments"],
            "additionalProperties": False,
        }
        payload = {
            "systemInstruction": {
                "parts": [
                    {
                        "text": (
                            f"Translate every segment into {target_name}. Preserve code identifiers, "
                            "commands, URLs, product names, placeholders, and technical meaning. "
                            "Return every input segment ID exactly once and do not add commentary."
                        )
                    }
                ]
            },
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {
                            "text": json.dumps(
                                provider_input,
                                ensure_ascii=False,
                                separators=(",", ":"),
                            )
                        }
                    ],
                }
            ],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseJsonSchema": schema,
            },
        }
        return Request(
            _generate_content_url(base_url, model, request.job_id),
            data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(),
            headers={
                "X-Goog-Api-Key": api_key,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )

    def _execute_with_retry(self, request: Request, job_id: str) -> HttpResponse:
        for attempt in range(self._max_attempts):
            try:
                response = self._transport(request, self._timeout_seconds)
            except (ProviderTransportError, TimeoutError, URLError, OSError):
                if attempt + 1 >= self._max_attempts:
                    raise WorkerError(
                        "TRANSLATION_PROVIDER_UNAVAILABLE",
                        "Không thể kết nối Gemini sau các lần thử có giới hạn. Transcript chưa được publish.",
                        job_id=job_id,
                        retryable=True,
                    )
                self._sleep(self._retry_delay(attempt, None))
                continue

            if 200 <= response.status <= 299:
                return response
            provider_status = _provider_error_status(response.body)
            if response.status in RETRYABLE_STATUSES and attempt + 1 < self._max_attempts:
                self._sleep(self._retry_delay(attempt, header(response.headers, "retry-after")))
                continue
            raise _http_error(response.status, provider_status, job_id)
        raise AssertionError("retry loop must return or raise")

    def _retry_delay(self, attempt: int, retry_after: str | None) -> float:
        delay = (2**attempt) * (0.5 + self._random_value())
        if retry_after is not None:
            try:
                delay = max(delay, float(retry_after))
            except ValueError:
                pass
        return min(MAX_RETRY_DELAY_SECONDS, max(0.05, delay))


def _chunk_segments(
    segments: list[Segment], *, max_segments: int, max_characters: int
) -> list[list[Segment]]:
    batches: list[list[Segment]] = []
    current: list[Segment] = []
    current_characters = 0
    for segment in segments:
        length = len(segment.text)
        if current and (
            len(current) >= max_segments or current_characters + length > max_characters
        ):
            batches.append(current)
            current = []
            current_characters = 0
        current.append(segment)
        current_characters += length
    if current:
        batches.append(current)
    return batches


def _generate_content_url(base_url: str, model: str, job_id: str) -> str:
    parsed = urlsplit(base_url.strip())
    if parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.hostname:
        raise WorkerError(
            "INVALID_REQUEST", "Provider Base URL is not safe", job_id=job_id
        )
    loopback = parsed.hostname.lower() == "localhost"
    if not loopback:
        try:
            loopback = ipaddress.ip_address(parsed.hostname).is_loopback
        except ValueError:
            loopback = False
    if parsed.scheme != "https" and not (parsed.scheme == "http" and loopback):
        raise WorkerError(
            "INVALID_REQUEST",
            "Provider Base URL must use HTTPS unless it is loopback",
            job_id=job_id,
        )
    model = model.strip().removeprefix("models/")
    if not model or len(model) > 256 or any(
        character.isspace() or not character.isprintable() for character in model
    ):
        raise WorkerError("INVALID_REQUEST", "Gemini model ID is invalid", job_id=job_id)
    path = f"{parsed.path.rstrip('/')}/v1beta/models/{quote(model, safe='')}:generateContent"
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def _parse_translations(
    body: bytes, job_id: str, source_segments: list[Segment]
) -> list[Segment]:
    try:
        response = json.loads(body)
        prompt_feedback = response.get("promptFeedback") or {}
        if prompt_feedback.get("blockReason"):
            raise WorkerError(
                "TRANSLATION_REFUSED",
                "Gemini chặn nội dung này. Không có output nào được publish.",
                job_id=job_id,
            )
        candidates = response.get("candidates")
        if not isinstance(candidates, list) or not candidates:
            raise ValueError("missing candidates")
        candidate = candidates[0]
        finish_reason = str(candidate.get("finishReason") or "").upper()
        if finish_reason in REFUSAL_REASONS:
            raise WorkerError(
                "TRANSLATION_REFUSED",
                "Gemini từ chối hoặc chặn nội dung này. Không có output nào được publish.",
                job_id=job_id,
            )
        if finish_reason and finish_reason != "STOP":
            raise ValueError("candidate did not finish normally")
        parts = candidate.get("content", {}).get("parts", [])
        text_parts = [part.get("text") for part in parts if isinstance(part.get("text"), str)]
        if not text_parts:
            raise ValueError("missing text parts")
        structured = json.loads("".join(text_parts))
        values = structured["segments"]
        if not isinstance(values, list):
            raise ValueError("segments must be an array")
        translated_by_id: dict[int, str] = {}
        for value in values:
            if not isinstance(value, dict):
                raise ValueError("segment must be an object")
            segment_id = value.get("id")
            text = value.get("text")
            if isinstance(segment_id, bool) or not isinstance(segment_id, int):
                raise ValueError("segment id must be an integer")
            if segment_id in translated_by_id or not isinstance(text, str) or not text.strip():
                raise ValueError("segment id/text is invalid")
            translated_by_id[segment_id] = text.strip()
        expected_ids = {segment.id for segment in source_segments}
        if set(translated_by_id) != expected_ids or len(values) != len(source_segments):
            raise ValueError("translated segment ids do not match input")
        return [
            Segment(
                id=segment.id,
                start=segment.start,
                end=segment.end,
                text=translated_by_id[segment.id],
            )
            for segment in source_segments
        ]
    except WorkerError:
        raise
    except (AttributeError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise WorkerError(
            "TRANSLATION_INVALID_RESPONSE",
            "Gemini trả về bản dịch không khớp segment local. Không có output nào được publish.",
            job_id=job_id,
            retryable=True,
        ) from error


def _provider_error_status(body: bytes) -> str:
    try:
        payload: Any = json.loads(body)
        return str(payload.get("error", {}).get("status") or "").strip().upper()
    except (AttributeError, TypeError, ValueError, json.JSONDecodeError):
        return ""


def _http_error(status: int, provider_status: str, job_id: str) -> WorkerError:
    if status == 401:
        return WorkerError(
            "PROVIDER_AUTH_FAILED",
            "Gemini từ chối API key. Kiểm tra account đã chọn rồi chạy lại.",
            job_id=job_id,
        )
    if status == 403:
        return WorkerError(
            "PROVIDER_PERMISSION_DENIED",
            "Gemini account không có quyền dùng model đã chọn.",
            job_id=job_id,
        )
    if status == 404 or provider_status == "NOT_FOUND":
        return WorkerError(
            "PROVIDER_MODEL_NOT_FOUND",
            "Không tìm thấy Gemini model hoặc Generate Content endpoint trên Base URL đã chọn.",
            job_id=job_id,
        )
    if status == 429 or provider_status == "RESOURCE_EXHAUSTED":
        return WorkerError(
            "TRANSLATION_QUOTA_OR_RATE_LIMIT",
            "Gemini vẫn báo RESOURCE_EXHAUSTED sau các lần retry. Kiểm tra RPM/TPM/RPD, quota hoặc spend tier rồi chạy lại.",
            job_id=job_id,
            retryable=True,
        )
    if status in {408, 500, 502, 503, 504}:
        return WorkerError(
            "TRANSLATION_PROVIDER_UNAVAILABLE",
            "Gemini tạm thời không khả dụng sau các lần retry có giới hạn.",
            job_id=job_id,
            retryable=True,
        )
    if 300 <= status <= 399:
        return WorkerError(
            "TRANSLATION_REDIRECT_BLOCKED",
            "Generate Content endpoint chuyển hướng; WhisperSub đã chặn để không gửi key/transcript sang host khác.",
            job_id=job_id,
        )
    return WorkerError(
        "TRANSLATION_REQUEST_REJECTED",
        f"Gemini từ chối translation request (HTTP {status}). Kiểm tra model và Base URL.",
        job_id=job_id,
    )
