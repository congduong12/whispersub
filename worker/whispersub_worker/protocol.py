from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

SUPPORTED_MODELS = {"tiny", "base", "small", "medium", "turbo"}
SUPPORTED_LANGUAGES = {"auto", "en", "vi"}
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
    if message.get("translationProvider", "none") != "none":
        raise WorkerError(
            "INVALID_REQUEST",
            "Translation providers are outside the local worker scope",
            job_id=job_id,
        )

    return StartJobRequest(
        job_id=job_id,
        input_path=input_path,
        output_location_mode=output_location_mode,
        output_directory=output_directory,
        model=model,
        source_language=source_language,
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
