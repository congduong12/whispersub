from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

SUPPORTED_MODELS = {"tiny", "base", "small", "medium", "turbo"}
SUPPORTED_LANGUAGES = {"auto", "en", "vi"}
SUPPORTED_TARGET_LANGUAGES = {"none", "en", "vi"}
SUPPORTED_DEVICES = {"auto", "mps", "cpu"}
SUPPORTED_FORMATS = {"srt", "vtt", "json"}
SUPPORTED_OVERWRITE_POLICIES = {"ask", "suffix", "overwrite"}


class WorkerError(RuntimeError):
    """A stable worker failure that is safe to expose through the JSONL protocol."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        job_id: str = "unknown",
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.job_id = job_id
        self.retryable = retryable

    def as_event(self) -> dict[str, Any]:
        return {
            "type": "error",
            "jobId": self.job_id,
            "code": self.code,
            "message": str(self),
            "retryable": self.retryable,
        }


ProtocolError = WorkerError


@dataclass(frozen=True)
class StartJobRequest:
    job_id: str
    input_path: Path
    output_location_mode: Literal["same_as_input", "custom_directory"]
    output_directory: Path | None
    model: str
    source_language: str
    target_language: str
    translation_provider: Literal["none", "openai_api", "gemini_api"]
    translation_mode: Literal["none", "technical_context"]
    technical_translation: bool
    glossary: str | None
    provider_model: str | None
    provider_api_key: str | None
    provider_base_url: str | None
    translation_consent: bool
    device: str
    output_formats: tuple[str, ...]
    overwrite_policy: str


def parse_start_job(message: dict[str, Any]) -> StartJobRequest:
    job_id = _required_string(message, "jobId")
    if message.get("type") != "start_job":
        raise WorkerError(
            "INVALID_REQUEST",
            f"Unsupported command: {message.get('type')!r}",
            job_id=job_id,
        )

    input_path = Path(_required_string(message, "inputPath", job_id=job_id)).expanduser()
    output_location_mode = message.get("outputLocationMode", "same_as_input")
    if output_location_mode not in {"same_as_input", "custom_directory"}:
        raise WorkerError(
            "INVALID_REQUEST",
            "outputLocationMode must be same_as_input or custom_directory",
            job_id=job_id,
        )

    raw_output_directory = message.get("outputDirectory")
    output_directory = (
        Path(raw_output_directory).expanduser()
        if isinstance(raw_output_directory, str) and raw_output_directory.strip()
        else None
    )
    if output_location_mode == "custom_directory" and output_directory is None:
        raise WorkerError(
            "INVALID_REQUEST",
            "outputDirectory is required for custom_directory mode",
            job_id=job_id,
        )

    model = _enum(message, "model", SUPPORTED_MODELS, "small", job_id)
    source_language = _enum(
        message, "sourceLanguage", SUPPORTED_LANGUAGES, "auto", job_id
    )
    target_language = _enum(
        message, "targetLanguage", SUPPORTED_TARGET_LANGUAGES, "none", job_id
    )
    device = _enum(message, "device", SUPPORTED_DEVICES, "auto", job_id)
    overwrite_policy = _enum(
        message, "overwritePolicy", SUPPORTED_OVERWRITE_POLICIES, "suffix", job_id
    )

    raw_formats = message.get("outputFormats", ["srt"])
    if not isinstance(raw_formats, list) or not raw_formats:
        raise WorkerError(
            "INVALID_REQUEST", "outputFormats must be a non-empty array", job_id=job_id
        )
    output_formats = tuple(dict.fromkeys(raw_formats))
    if any(not isinstance(value, str) or value not in SUPPORTED_FORMATS for value in output_formats):
        raise WorkerError(
            "INVALID_REQUEST", "outputFormats contains an unsupported format", job_id=job_id
        )
    if "srt" not in output_formats:
        raise WorkerError("INVALID_REQUEST", "SRT output is required", job_id=job_id)

    if message.get("task", "transcribe") != "transcribe":
        raise WorkerError("INVALID_REQUEST", "Only transcribe jobs are supported", job_id=job_id)
    translation_provider = message.get("translationProvider", "none")
    if translation_provider not in {"none", "openai_api", "gemini_api"}:
        raise WorkerError("INVALID_REQUEST", "Unsupported translationProvider", job_id=job_id)
    translation_mode = message.get("translationMode", "none")
    if translation_mode not in {"none", "technical_context"}:
        raise WorkerError("INVALID_REQUEST", "Unsupported translationMode", job_id=job_id)
    technical_translation = message.get("technicalTranslation", False)
    translation_consent = message.get("translationConsent", False)
    if not isinstance(technical_translation, bool) or not isinstance(translation_consent, bool):
        raise WorkerError(
            "INVALID_REQUEST",
            "Translation flags must be boolean",
            job_id=job_id,
        )
    glossary = _optional_string(message, "glossary", job_id)
    provider_model = _optional_string(message, "providerModel", job_id)
    provider_api_key = _optional_string(message, "providerApiKey", job_id)
    provider_base_url = _optional_string(message, "providerBaseUrl", job_id)

    if translation_provider == "none":
        if (
            target_language != "none"
            or translation_mode != "none"
            or technical_translation
            or translation_consent
            or provider_model is not None
            or provider_api_key is not None
            or provider_base_url is not None
        ):
            raise WorkerError(
                "INVALID_REQUEST",
                "Local-only jobs must not contain provider runtime configuration",
                job_id=job_id,
            )
    else:
        if target_language not in {"en", "vi"}:
            raise WorkerError(
                "INVALID_REQUEST", "Translation target must be en or vi", job_id=job_id
            )
        if translation_mode != "technical_context" or not technical_translation:
            raise WorkerError(
                "INVALID_REQUEST",
                "Provider translation requires technical_context mode",
                job_id=job_id,
            )
        if not translation_consent:
            raise WorkerError(
                "INVALID_REQUEST", "Explicit translation consent is required", job_id=job_id
            )
        if provider_model is None or len(provider_model) > 256:
            raise WorkerError(
                "INVALID_REQUEST", "providerModel is required and must be at most 256 characters", job_id=job_id
            )
        if provider_api_key is None or not 8 <= len(provider_api_key) <= 512:
            raise WorkerError(
                "INVALID_REQUEST", "providerApiKey is invalid", job_id=job_id
            )
        if provider_base_url is None or len(provider_base_url) > 2048:
            raise WorkerError(
                "INVALID_REQUEST", "providerBaseUrl is invalid", job_id=job_id
            )

    return StartJobRequest(
        job_id=job_id,
        input_path=input_path,
        output_location_mode=output_location_mode,
        output_directory=output_directory,
        model=model,
        source_language=source_language,
        target_language=target_language,
        translation_provider=translation_provider,
        translation_mode=translation_mode,
        technical_translation=technical_translation,
        glossary=glossary,
        provider_model=provider_model,
        provider_api_key=provider_api_key,
        provider_base_url=provider_base_url,
        translation_consent=translation_consent,
        device=device,
        output_formats=output_formats,
        overwrite_policy=overwrite_policy,
    )


def handle_message(message: dict[str, Any]) -> list[dict[str, Any]]:
    """Handle control messages that do not execute a transcription job."""

    if message.get("type") == "ping":
        return [{"type": "pong", "protocolVersion": 1, "worker": "local"}]
    parse_start_job(message)
    return []


def _required_string(message: dict[str, Any], key: str, *, job_id: str = "unknown") -> str:
    value = message.get(key)
    if not isinstance(value, str) or not value.strip():
        raise WorkerError(
            "INVALID_REQUEST", f"{key} must be a non-empty string", job_id=job_id
        )
    return value


def _optional_string(message: dict[str, Any], key: str, job_id: str) -> str | None:
    value = message.get(key)
    if value is None:
        return None
    if (
        not isinstance(value, str)
        or not value.strip()
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise WorkerError(
            "INVALID_REQUEST", f"{key} must be a non-empty safe string", job_id=job_id
        )
    return value.strip()


def _enum(
    message: dict[str, Any],
    key: str,
    supported: set[str],
    default: str,
    job_id: str,
) -> str:
    value = message.get(key, default)
    if not isinstance(value, str) or value not in supported:
        choices = ", ".join(sorted(supported))
        raise WorkerError(
            "INVALID_REQUEST", f"{key} must be one of: {choices}", job_id=job_id
        )
    return value
