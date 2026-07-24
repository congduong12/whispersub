from __future__ import annotations

from collections.abc import Callable

from worker.whispersub_worker.engine import EventCallback, TranscriptionEngine
from worker.whispersub_worker.protocol import StartJobRequest, WorkerError
from worker.whispersub_worker.subtitles import write_outputs
from worker.whispersub_worker.translation import TranslationProvider


def run_job(
    request: StartJobRequest,
    engine: TranscriptionEngine,
    emit: EventCallback,
    *,
    translator: TranslationProvider | None = None,
    readiness_check: Callable[[StartJobRequest], None] | None = None,
    output_writer: Callable[[StartJobRequest, list], list] = write_outputs,
) -> None:
    emit({"type": "job_started", "jobId": request.job_id})
    try:
        translated = request.translation_provider != "none"
        if translated:
            if translator is None:
                raise WorkerError(
                    "TRANSLATION_PROVIDER_UNAVAILABLE",
                    "Translation adapter is not available",
                    job_id=request.job_id,
                    retryable=True,
                )
            if readiness_check is not None:
                readiness_check(request)
        segments = engine.transcribe(request, emit)
        if translated:
            emit(
                {
                    "type": "phase_changed",
                    "jobId": request.job_id,
                    "phase": "translating",
                }
            )
            emit(
                {
                    "type": "progress",
                    "jobId": request.job_id,
                    "phase": "translating",
                    "percent": 92.0,
                }
            )
            segments = translator.translate(request, segments)
            emit(
                {
                    "type": "progress",
                    "jobId": request.job_id,
                    "phase": "translating",
                    "percent": 97.0,
                }
            )
        emit(
            {
                "type": "phase_changed",
                "jobId": request.job_id,
                "phase": "writing_output",
            }
        )
        emit(
            {
                "type": "progress",
                "jobId": request.job_id,
                "phase": "writing_output",
                "percent": 98.0 if translated else 95.0,
            }
        )
        outputs = output_writer(request, segments)
        emit(
            {
                "type": "completed",
                "jobId": request.job_id,
                "outputs": [str(path) for path in outputs],
            }
        )
    except WorkerError:
        raise
    except Exception as error:
        raise WorkerError(
            "UNKNOWN_ERROR", str(error), job_id=request.job_id, retryable=True
        ) from error
