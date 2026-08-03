"""Durable, privacy-minimal YouTube library records.

This is deliberately separate from the acceleration cache: deleting a library
record never touches exports or cache entries.
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from worker.whispersub_worker.engine import Segment
from worker.whispersub_worker.protocol import StartJobRequest, YoutubeSource
from worker.whispersub_worker.youtube import ResolvedTranscript
from worker.whispersub_worker.youtube_cache import (
    _canonical_video_id,
    _parse_segments,
    _safe_display_title,
)

LIBRARY_SCHEMA_VERSION = 1


def store_library_item(
    request: StartJobRequest,
    resolved: ResolvedTranscript,
    segments: list[Segment],
    outputs: list[Path],
) -> None:
    if not isinstance(request.source, YoutubeSource):
        return
    if request.youtube_library_path is None:
        raise ValueError("YouTube library path is required")
    video_id = _canonical_video_id(request.source.url)
    if video_id is None or not _safe_display_title(resolved.display_title):
        raise ValueError("library identity is invalid")
    payload = _segment_payload(segments)
    if not _parse_segments(payload):
        raise ValueError("library segments are invalid")
    root = request.youtube_library_path
    item_dir = root / "items" / video_id
    manifest_path = item_dir / "manifest.json"
    _reject_symlink(root)
    _reject_symlink(root / "items")
    _reject_symlink(item_dir)
    _reject_symlink(manifest_path)
    existing = _load_manifest(manifest_path, video_id)
    recipe = _recipe_fingerprint(request)
    version = {
        "recipeFingerprint": recipe,
        "createdAt": _now(),
        "sourceLanguage": resolved.source_language,
        "transcriptOrigin": resolved.origin,
        "exports": [str(path) for path in outputs],
        "segments": payload,
        "segmentsSha256": hashlib.sha256(_encode_segments(payload)).hexdigest(),
    }
    versions = (
        []
        if existing is None
        else [
            value
            for value in existing["versions"]
            if value["recipeFingerprint"] != recipe
        ]
    )
    versions.append(version)
    manifest = {
        "schemaVersion": LIBRARY_SCHEMA_VERSION,
        "videoId": video_id,
        "displayTitle": resolved.display_title,
        "updatedAt": _now(),
        "versions": versions,
    }
    item_dir.mkdir(parents=True, exist_ok=True)
    _private_dir(root)
    _private_dir(root / "items")
    _private_dir(item_dir)
    _atomic(manifest_path, _encode(manifest))


def _load_manifest(path: Path, video_id: str) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if not _valid_manifest(value, video_id):
            raise ValueError("existing library manifest is invalid")
        return value
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        raise ValueError("existing library manifest is corrupt") from error


def _valid_manifest(value: Any, video_id: str) -> bool:
    if (
        not isinstance(value, dict)
        or value.get("schemaVersion") != LIBRARY_SCHEMA_VERSION
        or value.get("videoId") != video_id
        or not _safe_display_title(value.get("displayTitle"))
        or not isinstance(value.get("versions"), list)
    ):
        return False

    for version in value["versions"]:
        if (
            not isinstance(version, dict)
            or not isinstance(version.get("recipeFingerprint"), str)
            or not isinstance(version.get("exports"), list)
            or not all(
                isinstance(path, str) and Path(path).is_absolute()
                for path in version["exports"]
            )
        ):
            return False

        payload = version.get("segments")
        if (
            not _parse_segments(payload)
            or version.get("segmentsSha256")
            != hashlib.sha256(_encode_segments(payload)).hexdigest()
        ):
            return False

    return bool(value["versions"])


def _recipe_fingerprint(request: StartJobRequest) -> str:
    recipe = {
        "model": request.model,
        "sourceLanguage": request.source_language,
        "targetLanguage": request.target_language,
        "translationProvider": request.translation_provider,
        "translationMode": request.translation_mode,
        "providerModel": request.provider_model,
        "glossary": request.glossary,
    }
    return hashlib.sha256(_encode(recipe)).hexdigest()


def _segment_payload(segments: list[Segment]) -> list[dict[str, Any]]:
    return [
        {
            "id": segment.id,
            "start": segment.start,
            "end": segment.end,
            "text": segment.text,
        }
        for segment in segments
    ]


def _encode(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _encode_segments(segments: list[dict[str, Any]]) -> bytes:
    canonical = [
        {
            "id": value["id"],
            "start": float(value["start"]),
            "end": float(value["end"]),
            "text": value["text"],
        }
        for value in segments
    ]
    return json.dumps(canonical, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _reject_symlink(path: Path) -> None:
    if path.is_symlink():
        raise ValueError(f"library path must not be a symlink: {path}")


def _private_dir(path: Path) -> None:
    if os.name != "nt":
        os.chmod(path, 0o700)


def _atomic(path: Path, payload: bytes) -> None:
    with tempfile.NamedTemporaryFile(
        mode="wb",
        dir=path.parent,
        prefix=".manifest.",
        delete=False,
    ) as handle:
        temp = Path(handle.name)
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())

    try:
        if os.name != "nt":
            os.chmod(temp, 0o600)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)
