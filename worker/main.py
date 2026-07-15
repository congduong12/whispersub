from __future__ import annotations

import json
import sys
from typing import Any

from worker.whispersub_worker.protocol import WorkerError, handle_message, parse_start_job
from worker.whispersub_worker.runner import run_job
from worker.whispersub_worker.whisper_engine import WhisperEngine


def emit(message: dict[str, Any]) -> None:
    print(json.dumps(message, ensure_ascii=False), flush=True)


def main() -> int:
    raw_line = next((line for line in sys.stdin if line.strip()), None)
    if raw_line is None:
        print("worker received no request", file=sys.stderr)
        return 1

    try:
        message = json.loads(raw_line)
        if not isinstance(message, dict):
            raise WorkerError("INVALID_REQUEST", "Request must be a JSON object")
        if message.get("type") == "ping":
            for event in handle_message(message):
                emit(event)
            return 0
        request = parse_start_job(message)
        run_job(request, WhisperEngine(), emit)
        return 0
    except json.JSONDecodeError as error:
        emit(WorkerError("INVALID_JSON", str(error)).as_event())
    except WorkerError as error:
        emit(error.as_event())
    except Exception as error:
        emit(WorkerError("UNKNOWN_ERROR", str(error), retryable=True).as_event())
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
