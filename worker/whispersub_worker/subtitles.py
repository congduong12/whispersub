from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from worker.whispersub_worker.engine import Segment
from worker.whispersub_worker.protocol import LocalFileSource, StartJobRequest, WorkerError


def write_outputs(
    request: StartJobRequest,
    segments: list[Segment],
    *,
    output_stem: str | None = None,
    existing_outputs: dict[str, Path] | None = None,
) -> list[Path]:
    validated = _validate_segments(segments, request.job_id)
    if request.output_location_mode == "same_as_input":
        if not isinstance(request.source, LocalFileSource):
            raise WorkerError(
                "OUTPUT_WRITE_FAILED",
                "YouTube subtitle output requires a custom directory",
                job_id=request.job_id,
            )
        output_dir = request.source.input_path.parent
    else:
        output_dir = request.output_directory
    if output_dir is None or not output_dir.exists() or not output_dir.is_dir():
        raise WorkerError(
            "OUTPUT_WRITE_FAILED",
            f"Output directory is not available: {output_dir}",
            job_id=request.job_id,
        )
    if not os.access(output_dir, os.W_OK):
        raise WorkerError(
            "PERMISSION_DENIED",
            f"Output directory is not writable: {output_dir}",
            job_id=request.job_id,
        )

    resolved_stem = output_stem or _default_output_stem(request)
    _validate_output_stem(resolved_stem, request.job_id)
    reusable = existing_outputs or {}
    missing_formats = tuple(
        output_format
        for output_format in request.output_formats
        if output_format not in reusable
    )
    destinations = _resolve_destinations(
        output_dir,
        resolved_stem,
        missing_formats,
        request.overwrite_policy,
        request.job_id,
    )
    rendered = {
        "srt": render_srt(validated),
        "vtt": render_vtt(validated),
        "json": render_json(validated),
    }
    staged: list[tuple[Path, Path]] = []
    try:
        for output_format, destination in destinations:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                newline="\n",
                dir=output_dir,
                prefix=f".{destination.stem}.",
                suffix=f".{output_format}.tmp",
                delete=False,
            ) as handle:
                handle.write(rendered[output_format])
                handle.flush()
                os.fsync(handle.fileno())
                staged.append((Path(handle.name), destination))
        for temporary, destination in staged:
            os.replace(temporary, destination)
        published = {
            **reusable,
            **{
                output_format: destination
                for output_format, destination in destinations
            },
        }
        return [published[output_format] for output_format in request.output_formats]
    except OSError as error:
        raise WorkerError(
            "OUTPUT_WRITE_FAILED",
            f"Unable to publish subtitle output: {error}",
            job_id=request.job_id,
        ) from error
    finally:
        for temporary, _ in staged:
            temporary.unlink(missing_ok=True)


def _default_output_stem(request: StartJobRequest) -> str:
    if not isinstance(request.source, LocalFileSource):
        raise WorkerError(
            "OUTPUT_WRITE_FAILED",
            "YouTube output name was not resolved",
            job_id=request.job_id,
        )
    return (
        request.source.input_path.stem
        if request.target_language == "none"
        else f"{request.source.input_path.stem}.{request.target_language}"
    )


def _validate_output_stem(stem: str, job_id: str) -> None:
    if (
        not stem
        or len(stem) > 128
        or stem in {".", ".."}
        or Path(stem).name != stem
        or "/" in stem
        or "\\" in stem
    ):
        raise WorkerError("OUTPUT_WRITE_FAILED", "Resolved output name is invalid", job_id=job_id)


def render_srt(segments: list[Segment]) -> str:
    cues = []
    for index, segment in enumerate(segments, start=1):
        cues.append(
            f"{index}\n{_timestamp(segment.start, ',')} --> {_timestamp(segment.end, ',')}\n{segment.text}\n"
        )
    return "\n".join(cues)


def render_vtt(segments: list[Segment]) -> str:
    cues = ["WEBVTT\n"]
    for segment in segments:
        cues.append(
            f"{_timestamp(segment.start, '.')} --> {_timestamp(segment.end, '.')}\n{segment.text}\n"
        )
    return "\n".join(cues)


def render_json(segments: list[Segment]) -> str:
    return json.dumps(
        {
            "segments": [
                {
                    "id": segment.id,
                    "start": segment.start,
                    "end": segment.end,
                    "text": segment.text,
                }
                for segment in segments
            ]
        },
        ensure_ascii=False,
        indent=2,
    ) + "\n"


def _validate_segments(segments: list[Segment], job_id: str) -> list[Segment]:
    validated: list[Segment] = []
    for segment in segments:
        text = segment.text.strip()
        if not text:
            continue
        if segment.start < 0 or segment.end <= segment.start:
            raise WorkerError(
                "TRANSCRIPTION_FAILED",
                f"Invalid timestamp range for segment {segment.id}",
                job_id=job_id,
            )
        validated.append(
            Segment(
                id=segment.id,
                start=segment.start,
                end=segment.end,
                text=text,
            )
        )
    return validated


def _resolve_destinations(
    directory: Path,
    stem: str,
    formats: tuple[str, ...],
    overwrite_policy: str,
    job_id: str,
) -> list[tuple[str, Path]]:
    def paths(candidate: str) -> list[tuple[str, Path]]:
        return [(output_format, directory / f"{candidate}.{output_format}") for output_format in formats]

    initial = paths(stem)
    if overwrite_policy == "overwrite" or not any(path.exists() for _, path in initial):
        return initial
    if overwrite_policy == "ask":
        raise WorkerError(
            "OUTPUT_WRITE_FAILED",
            f"Output already exists for {stem}",
            job_id=job_id,
        )
    suffix = 1
    while True:
        candidate = paths(f"{stem} ({suffix})")
        if not any(path.exists() for _, path in candidate):
            return candidate
        suffix += 1


def _timestamp(seconds: float, separator: str) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d}{separator}{millis:03d}"
