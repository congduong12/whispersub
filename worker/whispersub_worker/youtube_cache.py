from __future__ import annotations

import hashlib
import json
import os
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from worker.whispersub_worker.engine import Segment
from worker.whispersub_worker.protocol import StartJobRequest, WorkerError, YoutubeSource
from worker.whispersub_worker.youtube import ResolvedTranscript

CACHE_SCHEMA_VERSION = 1
_ORIGINS = {
    "manual_caption",
    "automatic_caption",
    "whisper_transcribe",
    "whisper_translate_to_english",
}


@dataclass(frozen=True)
class CachedYoutubeTranscript:
    segments: list[Segment]
    output_stem: str
    source_language: str
    transcript_language: str
    origin: str
    display_title: str


class YoutubeTranscriptCache:
    """Application Support cache for final Vietnamese YouTube segments.

    The cache key is derived from the canonical video ID and a versioned recipe.
    Raw URLs and downloaded media are never written here.
    """

    def __init__(self, root: Path) -> None:
        if not root.is_absolute():
            raise ValueError("YouTube cache root must be absolute")
        self._root = root

    def load(self, request: StartJobRequest) -> CachedYoutubeTranscript | None:
        identity = _cache_identity(request)
        if identity is None:
            return None
        source_key, recipe_fingerprint, entry = identity
        try:
            manifest = _read_json(entry / "manifest.json")
            transcript_bytes = (entry / "transcript.json").read_bytes()
            if not _valid_manifest(
                manifest,
                source_key=source_key,
                recipe_fingerprint=recipe_fingerprint,
                transcript_bytes=transcript_bytes,
            ):
                return None
            transcript = json.loads(transcript_bytes)
            segments = _parse_segments(transcript)
            if not segments:
                return None
            output_stem = manifest["outputStem"]
            display_title = manifest["displayTitle"]
            source_language = manifest["sourceLanguage"]
            transcript_language = manifest["transcriptLanguage"]
            origin = manifest["transcriptOrigin"]
            if (
                not _safe_output_stem(output_stem)
                or not _safe_display_title(display_title)
                or source_language not in {"en", "vi"}
                or transcript_language not in {"en", "vi"}
                or origin not in _ORIGINS
            ):
                return None
            return CachedYoutubeTranscript(
                segments=segments,
                output_stem=output_stem,
                source_language=source_language,
                transcript_language=transcript_language,
                origin=origin,
                display_title=display_title,
            )
        except (OSError, UnicodeError, ValueError, TypeError, KeyError, json.JSONDecodeError):
            return None

    def reusable_outputs(
        self, request: StartJobRequest, output_stem: str
    ) -> dict[str, Path]:
        identity = _cache_identity(request)
        if identity is None or request.output_directory is None:
            return {}
        source_key, recipe_fingerprint, entry = identity
        existing = _existing_exports(
            entry / "manifest.json", source_key, recipe_fingerprint
        )
        return _verified_exports(
            existing,
            request.output_directory,
            output_stem,
            request.output_formats,
        )

    def store(
        self,
        request: StartJobRequest,
        resolved: ResolvedTranscript,
        final_segments: list[Segment],
        outputs: list[Path],
    ) -> None:
        identity = _cache_identity(request)
        if identity is None:
            raise WorkerError(
                "YOUTUBE_CACHE_KEY_UNAVAILABLE",
                "The YouTube URL does not contain a supported canonical video ID",
                job_id=request.job_id,
                retryable=False,
            )
        source_key, recipe_fingerprint, entry = identity
        transcript_payload = [
            {
                "id": segment.id,
                "start": segment.start,
                "end": segment.end,
                "text": segment.text,
            }
            for segment in final_segments
        ]
        if not _parse_segments(transcript_payload):
            raise WorkerError(
                "YOUTUBE_CACHE_WRITE_FAILED",
                "Final subtitle segments are not valid for caching",
                job_id=request.job_id,
                retryable=True,
            )

        transcript_bytes = _encode_json(transcript_payload)
        exports = _merge_exports(
            _existing_exports(entry / "manifest.json", source_key, recipe_fingerprint),
            outputs,
        )
        manifest = {
            "schemaVersion": CACHE_SCHEMA_VERSION,
            "sourceKey": source_key,
            "recipeFingerprint": recipe_fingerprint,
            "transcriptSha256": hashlib.sha256(transcript_bytes).hexdigest(),
            "outputStem": resolved.output_stem,
            "sourceLanguage": resolved.source_language,
            "transcriptLanguage": resolved.transcript_language,
            "transcriptOrigin": resolved.origin,
            "displayTitle": resolved.display_title,
            "createdAt": _utc_now(),
            "exports": exports,
        }
        try:
            entry.mkdir(parents=True, exist_ok=True)
            _write_atomic(entry / "transcript.json", transcript_bytes)
            _write_atomic(entry / "manifest.json", _encode_json(manifest))
        except OSError as error:
            raise WorkerError(
                "YOUTUBE_CACHE_WRITE_FAILED",
                f"Unable to update the local YouTube cache: {error}",
                job_id=request.job_id,
                retryable=True,
            ) from error


def _cache_identity(request: StartJobRequest) -> tuple[str, str, Path] | None:
    if not isinstance(request.source, YoutubeSource) or request.youtube_cache_path is None:
        return None
    video_id = _canonical_video_id(request.source.url)
    if video_id is None:
        return None
    source_key = hashlib.sha256(f"youtube:{video_id}".encode()).hexdigest()
    recipe = {
        "schemaVersion": CACHE_SCHEMA_VERSION,
        "model": request.model,
        "sourceLanguage": request.source_language,
        "targetLanguage": request.target_language,
        "translationProvider": request.translation_provider,
        "translationMode": request.translation_mode,
        "providerModel": request.provider_model,
        "glossary": request.glossary,
    }
    recipe_fingerprint = hashlib.sha256(_encode_json(recipe)).hexdigest()
    entry_key = hashlib.sha256(f"{source_key}:{recipe_fingerprint}".encode()).hexdigest()
    return source_key, recipe_fingerprint, request.youtube_cache_path / "entries" / entry_key


def _canonical_video_id(url: str) -> str | None:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    candidate: str | None = None
    if host == "youtu.be":
        candidate = parsed.path.strip("/").split("/", maxsplit=1)[0]
    elif host in {"youtube.com", "www.youtube.com", "m.youtube.com"}:
        if parsed.path == "/watch":
            candidate = parse_qs(parsed.query).get("v", [None])[0]
        else:
            parts = [part for part in parsed.path.split("/") if part]
            if len(parts) == 2 and parts[0] in {"embed", "shorts", "live"}:
                candidate = parts[1]
    return candidate if isinstance(candidate, str) and _safe_video_id(candidate) else None


def _valid_manifest(
    manifest: Any,
    *,
    source_key: str,
    recipe_fingerprint: str,
    transcript_bytes: bytes,
) -> bool:
    return (
        isinstance(manifest, dict)
        and manifest.get("schemaVersion") == CACHE_SCHEMA_VERSION
        and manifest.get("sourceKey") == source_key
        and manifest.get("recipeFingerprint") == recipe_fingerprint
        and manifest.get("transcriptSha256")
        == hashlib.sha256(transcript_bytes).hexdigest()
        and isinstance(manifest.get("exports", []), list)
    )


def _parse_segments(value: Any) -> list[Segment]:
    if not isinstance(value, list):
        return []
    segments: list[Segment] = []
    for expected_id, item in enumerate(value):
        if not isinstance(item, dict):
            return []
        segment_id = item.get("id")
        start = item.get("start")
        end = item.get("end")
        text = item.get("text")
        if (
            segment_id != expected_id
            or isinstance(start, bool)
            or not isinstance(start, (int, float))
            or isinstance(end, bool)
            or not isinstance(end, (int, float))
            or float(start) < 0
            or float(end) <= float(start)
            or not isinstance(text, str)
            or not text.strip()
        ):
            return []
        segments.append(
            Segment(
                id=segment_id,
                start=float(start),
                end=float(end),
                text=text.strip(),
            )
        )
    return segments


def _existing_exports(
    manifest_path: Path, source_key: str, recipe_fingerprint: str
) -> list[dict[str, str]]:
    try:
        manifest = _read_json(manifest_path)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return []
    if (
        not isinstance(manifest, dict)
        or manifest.get("sourceKey") != source_key
        or manifest.get("recipeFingerprint") != recipe_fingerprint
        or not isinstance(manifest.get("exports"), list)
    ):
        return []
    return [
        item
        for item in manifest["exports"]
        if isinstance(item, dict)
        and isinstance(item.get("path"), str)
        and isinstance(item.get("sha256"), str)
        and isinstance(item.get("writtenAt"), str)
    ]


def _merge_exports(
    existing: list[dict[str, str]], outputs: list[Path]
) -> list[dict[str, str]]:
    by_path = {
        item["path"]: item
        for item in existing
        if isinstance(item.get("path"), str)
    }
    for output in outputs:
        try:
            digest = hashlib.sha256(output.read_bytes()).hexdigest()
        except OSError:
            continue
        by_path[str(output)] = {
            "path": str(output),
            "sha256": digest,
            "writtenAt": _utc_now(),
        }
    return sorted(by_path.values(), key=lambda item: item["path"])


def _verified_exports(
    existing: list[dict[str, str]],
    directory: Path,
    output_stem: str,
    formats: tuple[str, ...],
) -> dict[str, Path]:
    reusable: dict[str, Path] = {}
    for output_format in formats:
        canonical = directory / f"{output_stem}.{output_format}"
        candidates: list[Path] = []
        for item in existing:
            path = Path(item["path"])
            suffixed_prefix = f"{output_stem} ("
            if (
                not path.is_absolute()
                or path.parent != directory
                or path.suffix != f".{output_format}"
                or (
                    path != canonical
                    and not (
                        path.name.startswith(suffixed_prefix)
                        and path.name.endswith(f").{output_format}")
                    )
                )
                or path.is_symlink()
                or not path.is_file()
            ):
                continue
            try:
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
            except OSError:
                continue
            if digest == item["sha256"]:
                candidates.append(path)
        if candidates:
            reusable[output_format] = min(
                candidates,
                key=lambda path: (path != canonical, path.name),
            )
    return reusable


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _encode_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _write_atomic(path: Path, payload: bytes) -> None:
    with tempfile.NamedTemporaryFile(
        mode="wb",
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as handle:
        temporary = Path(handle.name)
        try:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _safe_video_id(value: str) -> bool:
    return 6 <= len(value) <= 32 and all(
        character.isascii() and (character.isalnum() or character in {"-", "_"})
        for character in value
    )


def _safe_output_stem(value: Any) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= 128
        and value not in {".", ".."}
        and Path(value).name == value
        and "/" not in value
        and "\\" not in value
    )


def _safe_display_title(value: Any) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= 80
        and all(character.isalnum() or character in {" ", "-", "_"} for character in value)
    )


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()
