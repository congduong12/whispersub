from __future__ import annotations

import shutil
from typing import Any

from worker.whispersub_worker.engine import EventCallback, Segment
from worker.whispersub_worker.protocol import StartJobRequest, WorkerError


class WhisperEngine:
    """Lazy adapter around openai-whisper so protocol tests stay dependency-light."""

    def transcribe(self, request: StartJobRequest, emit: EventCallback) -> list[Segment]:
        if not request.input_path.exists() or not request.input_path.is_file():
            raise WorkerError(
                "INVALID_INPUT",
                f"Input file does not exist: {request.input_path}",
                job_id=request.job_id,
            )
        if shutil.which("ffmpeg") is None:
            raise WorkerError(
                "FFMPEG_NOT_FOUND",
                "ffmpeg is required for local transcription",
                job_id=request.job_id,
            )

        try:
            import torch
            import whisper
        except ImportError as error:
            raise WorkerError(
                "MODEL_LOAD_FAILED",
                "openai-whisper is not installed; run pnpm worker:install",
                job_id=request.job_id,
                retryable=True,
            ) from error

        device = self._resolve_device(request.device, torch, request.job_id)
        _emit_phase(emit, request.job_id, "loading_model", 10.0)
        try:
            model = whisper.load_model(request.model, device=device)
        except Exception as error:
            raise WorkerError(
                "MODEL_LOAD_FAILED",
                f"Unable to load Whisper model {request.model}: {error}",
                job_id=request.job_id,
                retryable=True,
            ) from error

        _emit_phase(emit, request.job_id, "extracting_audio", 25.0)
        _emit_phase(emit, request.job_id, "transcribing", 35.0)
        options: dict[str, Any] = {
            "task": "transcribe",
            "verbose": None,
            "fp16": device != "cpu",
        }
        if request.source_language != "auto":
            options["language"] = request.source_language

        try:
            result = model.transcribe(str(request.input_path), **options)
        except FileNotFoundError as error:
            raise WorkerError(
                "FFMPEG_NOT_FOUND", str(error), job_id=request.job_id
            ) from error
        except Exception as error:
            raise WorkerError(
                "TRANSCRIPTION_FAILED",
                f"Whisper transcription failed: {error}",
                job_id=request.job_id,
                retryable=True,
            ) from error

        segments = [self._segment(value, index, request.job_id) for index, value in enumerate(result.get("segments", []))]
        if not segments and str(result.get("text", "")).strip():
            segments = [
                Segment(
                    id=0,
                    start=0.0,
                    end=0.001,
                    text=str(result["text"]).strip(),
                )
            ]
        for segment in segments:
            emit(
                {
                    "type": "segment",
                    "jobId": request.job_id,
                    "segment": {
                        "id": segment.id,
                        "start": segment.start,
                        "end": segment.end,
                        "text": segment.text,
                    },
                }
            )
        emit(_progress(request.job_id, "transcribing", 90.0))
        return segments

    @staticmethod
    def _resolve_device(requested: str, torch: Any, job_id: str) -> str:
        mps_available = bool(
            getattr(getattr(torch, "backends", None), "mps", None)
            and torch.backends.mps.is_available()
        )
        if requested == "mps" and not mps_available:
            raise WorkerError(
                "MODEL_LOAD_FAILED",
                "MPS was requested but is not available",
                job_id=job_id,
                retryable=True,
            )
        if requested == "auto":
            return "mps" if mps_available else "cpu"
        return requested

    @staticmethod
    def _segment(value: Any, fallback_id: int, job_id: str) -> Segment:
        try:
            return Segment(
                id=int(value.get("id", fallback_id)),
                start=float(value["start"]),
                end=float(value["end"]),
                text=str(value["text"]).strip(),
            )
        except (KeyError, TypeError, ValueError) as error:
            raise WorkerError(
                "TRANSCRIPTION_FAILED",
                "Whisper returned an invalid segment",
                job_id=job_id,
            ) from error


def _emit_phase(emit: EventCallback, job_id: str, phase: str, percent: float) -> None:
    emit({"type": "phase_changed", "jobId": job_id, "phase": phase})
    emit(_progress(job_id, phase, percent))


def _progress(job_id: str, phase: str, percent: float) -> dict[str, object]:
    return {
        "type": "progress",
        "jobId": job_id,
        "phase": phase,
        "percent": percent,
    }
