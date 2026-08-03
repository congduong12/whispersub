from __future__ import annotations

import shutil
import subprocess
from typing import Any

import numpy as np

from worker.whispersub_worker.engine import EventCallback, Segment
from worker.whispersub_worker.protocol import StartJobRequest, WorkerError

YOUTUBE_LANGUAGE_CONFIDENCE_THRESHOLD = 0.80


class WhisperEngine:
    """Lazy adapter around openai-whisper so protocol tests stay dependency-light."""

    def transcribe(self, request: StartJobRequest, emit: EventCallback) -> list[Segment]:
        return self._transcribe(
            request,
            request.input_path,
            source_language=request.source_language,
            task="transcribe",
            emit=emit,
        )[0]

    def transcribe_youtube_audio(
        self,
        request: StartJobRequest,
        input_path,
        *,
        source_language: str,
        emit: EventCallback,
    ) -> tuple[list[Segment], str, str]:
        whisper, device, model = self._load_runtime(request, input_path, emit)
        detected_language = (
            self._detect_youtube_language(
                request, input_path, whisper, device, model, emit
            )
            if source_language == "auto"
            else source_language
        )

        is_vietnamese = detected_language == "vi"
        task = "transcribe" if is_vietnamese else "translate"
        segments, _ = self._transcribe_with_model(
            request,
            input_path,
            source_language=detected_language,
            task=task,
            emit=emit,
            device=device,
            model=model,
        )
        return (
            segments,
            "vi" if is_vietnamese else "en",
            "whisper_transcribe"
            if is_vietnamese
            else "whisper_translate_to_english",
        )

    def _transcribe(
        self,
        request: StartJobRequest,
        input_path,
        *,
        source_language: str,
        task: str,
        emit: EventCallback,
    ) -> tuple[list[Segment], str | None]:
        _whisper, device, model = self._load_runtime(request, input_path, emit)
        return self._transcribe_with_model(
            request,
            input_path,
            source_language=source_language,
            task=task,
            emit=emit,
            device=device,
            model=model,
        )

    def _load_runtime(
        self,
        request: StartJobRequest,
        input_path,
        emit: EventCallback,
    ) -> tuple[Any, str, Any]:
        if not input_path.exists() or not input_path.is_file():
            raise WorkerError(
                "INVALID_INPUT",
                f"Input file does not exist: {input_path}",
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
        return whisper, device, model

    def _detect_youtube_language(
        self,
        request: StartJobRequest,
        input_path,
        whisper: Any,
        device: str,
        model: Any,
        emit: EventCallback,
    ) -> str:
        _emit_phase(emit, request.job_id, "detecting_language", 20.0)
        try:
            sample = self._load_youtube_language_sample(input_path, whisper)
            mel = whisper.log_mel_spectrogram(
                sample,
                n_mels=model.dims.n_mels,
                device=device,
            )
            _tokens, probabilities = model.detect_language(mel)
            if isinstance(probabilities, list):
                probabilities = probabilities[0]
            language, confidence = max(
                probabilities.items(), key=lambda item: item[1]
            )
        except WorkerError:
            raise
        except Exception as error:
            raise WorkerError(
                "SOURCE_LANGUAGE_UNDETERMINED",
                f"Unable to detect a confident source language: {error}",
                job_id=request.job_id,
                retryable=True,
            ) from error

        if confidence < YOUTUBE_LANGUAGE_CONFIDENCE_THRESHOLD:
            raise WorkerError(
                "SOURCE_LANGUAGE_UNDETERMINED",
                "Whisper language confidence is below 0.80",
                job_id=request.job_id,
            )
        return str(language)

    @staticmethod
    def _load_youtube_language_sample(input_path, whisper: Any) -> Any:
        audio_constants = whisper.audio
        sample_rate = int(audio_constants.SAMPLE_RATE)
        sample_length = int(audio_constants.N_SAMPLES)
        sample_duration_seconds = sample_length // sample_rate
        completed = subprocess.run(
            [
                shutil.which("ffmpeg") or "ffmpeg",
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-t",
                str(sample_duration_seconds),
                "-i",
                str(input_path),
                "-f",
                "s16le",
                "-ac",
                "1",
                "-ar",
                str(sample_rate),
                "pipe:1",
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        audio = np.frombuffer(completed.stdout, np.int16).astype(np.float32) / 32768.0
        return whisper.pad_or_trim(audio, length=sample_length)

    def _transcribe_with_model(
        self,
        request: StartJobRequest,
        input_path,
        *,
        source_language: str,
        task: str,
        emit: EventCallback,
        device: str,
        model: Any,
    ) -> tuple[list[Segment], str | None]:
        _emit_phase(emit, request.job_id, "extracting_audio", 25.0)
        _emit_phase(emit, request.job_id, "transcribing", 35.0)
        options: dict[str, Any] = {
            "task": task,
            "verbose": None,
            "fp16": device != "cpu",
        }
        if source_language != "auto":
            options["language"] = source_language

        try:
            result = model.transcribe(str(input_path), **options)
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

        segments = [
            self._segment(value, index, request.job_id)
            for index, value in enumerate(result.get("segments", []))
        ]
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
        language = result.get("language")
        return segments, language if isinstance(language, str) else None

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


def _emit_phase(
    emit: EventCallback, job_id: str, phase: str, percent: float
) -> None:
    emit({"type": "phase_changed", "jobId": job_id, "phase": phase})
    emit(_progress(job_id, phase, percent))


def _progress(job_id: str, phase: str, percent: float) -> dict[str, object]:
    return {
        "type": "progress",
        "jobId": job_id,
        "phase": phase,
        "percent": percent,
    }
