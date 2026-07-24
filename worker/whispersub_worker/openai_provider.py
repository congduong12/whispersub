from __future__ import annotations

import ipaddress
import json
import time
from collections.abc import Callable
from random import random
from typing import Any
from urllib.error import URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request

from worker.whispersub_worker.engine import Segment
from worker.whispersub_worker.provider_http import (
    HttpResponse,
    ProviderTransportError as _ProviderTransportError,
    Transport,
    default_transport as _default_transport,
    header as _header,
)
from worker.whispersub_worker.protocol import StartJobRequest, WorkerError

MAX_BATCH_SEGMENTS = 50
MAX_BATCH_CHARACTERS = 12_000
MAX_ATTEMPTS = 3
MAX_RETRY_DELAY_SECONDS = 8.0
REQUEST_TIMEOUT_SECONDS = 30.0
RETRYABLE_STATUSES = {408, 409, 429, 500, 502, 503, 504}
QUOTA_CODES = {
    "billing_hard_limit_reached",
    "billing_not_active",
    "insufficient_quota",
    "usage_limit_reached",
}

class OpenAITranslationAdapter:
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
        self._transport = transport or _default_transport
        self._sleep = sleep
        self._random_value = random_value
        self._max_attempts = max_attempts
        self._max_batch_segments = max_batch_segments
        self._max_batch_characters = max_batch_characters
        self._timeout_seconds = timeout_seconds

    def preflight(self, request: StartJobRequest) -> None:
        if request.translation_provider != "openai_api":
            raise WorkerError(
                "INVALID_REQUEST",
                "OpenAI adapter received a different provider",
                job_id=request.job_id,
            )
        try:
            self._execute_with_retry(
                self._build_preflight_request(request),
                request.job_id,
            )
        except WorkerError as error:
            if error.code == "TRANSLATION_QUOTA_EXCEEDED":
                raise WorkerError(
                    "OPENAI_BILLING_NOT_READY",
                    "OpenAI chưa cho phép tạo response vì billing/credit không khả dụng. Whisper chưa được chạy.",
                    job_id=request.job_id,
                ) from error
            raise

    def translate(
        self, request: StartJobRequest, segments: list[Segment]
    ) -> list[Segment]:
        if request.translation_provider != "openai_api":
            raise WorkerError(
                "INVALID_REQUEST",
                "OpenAI adapter received a different provider",
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
        api_key, base_url, model = _runtime_config(request)
        target_name = "Vietnamese" if request.target_language == "vi" else "English"
        provider_input = {
            "targetLanguage": request.target_language,
            "segments": [{"id": segment.id, "text": segment.text} for segment in segments],
        }
        payload = {
            "model": model,
            "instructions": (
                f"Translate every segment into {target_name}. Preserve code identifiers, "
                "commands, URLs, product names, placeholders, and technical meaning. "
                "Return every input segment ID exactly once and do not add commentary."
            ),
            "input": json.dumps(provider_input, ensure_ascii=False, separators=(",", ":")),
            "store": False,
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "translated_segments",
                    "strict": True,
                    "schema": {
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
                    },
                }
            },
        }
        return _provider_request(
            base_url=base_url,
            api_key=api_key,
            job_id=request.job_id,
            payload=payload,
        )

    def _build_preflight_request(self, request: StartJobRequest) -> Request:
        api_key, base_url, model = _runtime_config(request)
        payload = {
            "model": model,
            "instructions": (
                "Return JSON matching the schema. This is a capability check using "
                "only fixed WhisperSub content."
            ),
            "input": "WhisperSub readiness check. Return the requested JSON only.",
            "max_output_tokens": 32,
            "store": False,
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "whispersub_readiness",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "properties": {"ready": {"type": "boolean"}},
                        "required": ["ready"],
                        "additionalProperties": False,
                    },
                }
            },
        }
        return _provider_request(
            base_url=base_url,
            api_key=api_key,
            job_id=request.job_id,
            payload=payload,
        )

    def _execute_with_retry(self, request: Request, job_id: str) -> HttpResponse:
        for attempt in range(self._max_attempts):
            try:
                response = self._transport(request, self._timeout_seconds)
            except (_ProviderTransportError, TimeoutError, URLError, OSError):
                if attempt + 1 >= self._max_attempts:
                    raise WorkerError(
                        "TRANSLATION_PROVIDER_UNAVAILABLE",
                        "Không thể kết nối OpenAI sau các lần thử có giới hạn. Transcript chưa được publish.",
                        job_id=job_id,
                        retryable=True,
                    )
                self._sleep(self._retry_delay(attempt, None))
                continue

            if 200 <= response.status <= 299:
                return response
            provider_code = _provider_error_code(response.body)
            if response.status == 429 and provider_code in QUOTA_CODES:
                raise WorkerError(
                    "TRANSLATION_QUOTA_EXCEEDED",
                    "OpenAI account đã hết quota hoặc chạm giới hạn billing. Kiểm tra billing/limits rồi chạy lại.",
                    job_id=job_id,
                )
            if response.status in RETRYABLE_STATUSES and attempt + 1 < self._max_attempts:
                self._sleep(
                    self._retry_delay(attempt, _header(response.headers, "retry-after"))
                )
                continue
            raise _http_error(response.status, provider_code, job_id)
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


def _runtime_config(request: StartJobRequest) -> tuple[str, str, str]:
    api_key = request.provider_api_key
    base_url = request.provider_base_url
    model = request.provider_model
    if not api_key or not base_url or not model:
        raise WorkerError(
            "INVALID_REQUEST",
            "OpenAI runtime configuration is incomplete",
            job_id=request.job_id,
        )
    return api_key, base_url, model


def _provider_request(
    *,
    base_url: str,
    api_key: str,
    job_id: str,
    payload: dict[str, Any],
) -> Request:
    return Request(
        _responses_url(base_url, job_id),
        data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )


def _responses_url(base_url: str, job_id: str) -> str:
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
    path = f"{parsed.path.rstrip('/')}/responses"
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def _parse_translations(
    body: bytes, job_id: str, source_segments: list[Segment]
) -> list[Segment]:
    try:
        response = json.loads(body)
        if response.get("status") != "completed":
            raise ValueError("response is incomplete")
        output_text: str | None = None
        for output in response.get("output", []):
            if output.get("type") != "message":
                continue
            for content in output.get("content", []):
                if content.get("type") == "refusal":
                    raise WorkerError(
                        "TRANSLATION_REFUSED",
                        "OpenAI từ chối dịch nội dung này. Không có output nào được publish.",
                        job_id=job_id,
                    )
                if content.get("type") == "output_text" and isinstance(content.get("text"), str):
                    output_text = content["text"]
                    break
        if output_text is None:
            raise ValueError("missing output_text")
        structured = json.loads(output_text)
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
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise WorkerError(
            "TRANSLATION_INVALID_RESPONSE",
            "OpenAI trả về bản dịch không khớp segment local. Không có output nào được publish.",
            job_id=job_id,
            retryable=True,
        ) from error


def _provider_error_code(body: bytes) -> str:
    try:
        payload = json.loads(body)
        error = payload.get("error", {})
        value = error.get("code") or error.get("type") or ""
        return str(value).strip().lower()
    except (AttributeError, TypeError, ValueError, json.JSONDecodeError):
        return ""


def _http_error(status: int, provider_code: str, job_id: str) -> WorkerError:
    if status == 401:
        return WorkerError(
            "PROVIDER_AUTH_FAILED",
            "OpenAI từ chối API key. Kiểm tra account đã chọn rồi chạy lại.",
            job_id=job_id,
        )
    if status == 403:
        return WorkerError(
            "PROVIDER_PERMISSION_DENIED",
            "OpenAI account không có quyền dùng model hoặc Responses API đã chọn.",
            job_id=job_id,
        )
    if status == 404 or "model" in provider_code:
        return WorkerError(
            "PROVIDER_MODEL_NOT_FOUND",
            "Không tìm thấy model hoặc Responses endpoint trên Base URL đã chọn.",
            job_id=job_id,
        )
    if status == 429:
        return WorkerError(
            "TRANSLATION_RATE_LIMITED",
            "OpenAI vẫn rate-limit sau các lần retry có giới hạn. Chờ rồi chạy lại.",
            job_id=job_id,
            retryable=True,
        )
    if status in {408, 409, 500, 502, 503, 504}:
        return WorkerError(
            "TRANSLATION_PROVIDER_UNAVAILABLE",
            "OpenAI tạm thời không khả dụng sau các lần retry có giới hạn.",
            job_id=job_id,
            retryable=True,
        )
    if 300 <= status <= 399:
        return WorkerError(
            "TRANSLATION_REDIRECT_BLOCKED",
            "Responses endpoint chuyển hướng; WhisperSub đã chặn để không gửi key/transcript sang host khác.",
            job_id=job_id,
        )
    return WorkerError(
        "TRANSLATION_REQUEST_REJECTED",
        f"OpenAI từ chối translation request (HTTP {status}). Kiểm tra model và Base URL.",
        job_id=job_id,
    )
