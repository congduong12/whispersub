from __future__ import annotations

from collections.abc import Callable

from worker.whispersub_worker.engine import EventCallback, TranscriptionEngine
from worker.whispersub_worker.protocol import StartJobRequest, WorkerError
from worker.whispersub_worker.subtitles import write_outputs


def run_job(
    request: StartJobRequest,
    engine: TranscriptionEngine,
    emit: EventCallback,
    *,
    output_writer: Callable[[StartJobRequest, list], list] = write_outputs,
) -> None:
    emit({"type": "job_started", "jobId": request.job_id})
    try:
        segments = engine.transcribe(request, emit)
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
                "percent": 95.0,
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
