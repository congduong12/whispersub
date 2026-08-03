from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
import shutil
import unicodedata

from worker.whispersub_worker.engine import EventCallback, Segment
from worker.whispersub_worker.protocol import StartJobRequest, WorkerError, YoutubeSource


@dataclass(frozen=True)
class CaptionTrack:
    language: str
    automatic: bool
    extension: str | None


@dataclass(frozen=True)
class YoutubeVideo:
    video_id: str
    title: str
    is_live: bool
    subtitles: dict[str, tuple[CaptionTrack, ...]]
    automatic_captions: dict[str, tuple[CaptionTrack, ...]]
    duration_seconds: float | None = None


@dataclass(frozen=True)
class ResolvedTranscript:
    segments: list[Segment]
    output_stem: str
    source_language: str
    transcript_language: str
    origin: str
    display_title: str = "YouTube video"


class YoutubeClient(Protocol):
    def inspect(self, url: str) -> YoutubeVideo: ...

    def download_caption(self, url: str, track: CaptionTrack, workspace: Path) -> Path: ...

    def download_audio(self, url: str, workspace: Path) -> Path: ...


class YoutubeDlClient:
    """Small yt-dlp boundary. Tests inject a fake client instead of network calls."""

    def inspect(self, url: str) -> YoutubeVideo:
        try:
            from yt_dlp import YoutubeDL
        except ImportError as error:
            raise WorkerError(
                "YTDLP_NOT_READY",
                "yt-dlp is not installed; run pnpm worker:install",
                retryable=True,
            ) from error

        options = {
            "ignoreconfig": True,
            "noplaylist": True,
            "skip_download": True,
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
        }
        try:
            with YoutubeDL(options) as downloader:
                info = downloader.extract_info(url, download=False)
        except Exception as error:
            mapped = _yt_dlp_runtime_error(error)
            if mapped is not None:
                raise mapped from error
            raise WorkerError(
                "YOUTUBE_METADATA_FAILED",
                "Unable to inspect the public YouTube video",
                retryable=True,
            ) from error
        if not isinstance(info, dict):
            raise WorkerError("YOUTUBE_UNSUPPORTED_RESOURCE", "Unsupported YouTube resource")
        video_id = info.get("id")
        title = info.get("title")
        if not isinstance(video_id, str) or not _safe_video_id(video_id) or not isinstance(title, str):
            raise WorkerError("YOUTUBE_UNSUPPORTED_RESOURCE", "Unsupported YouTube resource")
        return YoutubeVideo(
            video_id=video_id,
            title=title,
            is_live=bool(info.get("is_live")),
            subtitles=_catalog(info.get("subtitles"), automatic=False),
            automatic_captions=_catalog(info.get("automatic_captions"), automatic=True),
            duration_seconds=_duration(info.get("duration")),
        )

    def download_caption(self, url: str, track: CaptionTrack, workspace: Path) -> Path:
        try:
            from yt_dlp import YoutubeDL
        except ImportError as error:
            raise WorkerError(
                "YTDLP_NOT_READY",
                "yt-dlp is not installed; run pnpm worker:install",
                retryable=True,
            ) from error

        workspace.mkdir(parents=True, exist_ok=True)
        options = {
            "ignoreconfig": True,
            "noplaylist": True,
            "skip_download": True,
            "writesubtitles": not track.automatic,
            "writeautomaticsub": track.automatic,
            "subtitleslangs": [track.language],
            "subtitlesformat": "vtt/srt/best",
            "outtmpl": str(workspace / "caption.%(ext)s"),
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
        }
        try:
            with YoutubeDL(options) as downloader:
                result = downloader.download([url])
        except Exception as error:
            mapped = _yt_dlp_runtime_error(error)
            if mapped is not None:
                raise mapped from error
            raise WorkerError(
                "YOUTUBE_CAPTION_FETCH_FAILED",
                "Unable to download the selected YouTube caption",
                retryable=True,
            ) from error
        if result:
            raise WorkerError(
                "YOUTUBE_CAPTION_FETCH_FAILED",
                "Unable to download the selected YouTube caption",
                retryable=True,
            )
        candidates = [
            path
            for path in workspace.glob("caption*")
            if path.is_file() and path.suffix.lower() in {".vtt", ".srt"}
        ]
        if len(candidates) != 1:
            raise WorkerError(
                "YOUTUBE_CAPTION_FETCH_FAILED",
                "Selected YouTube caption was not written to the job workspace",
                retryable=True,
            )
        return candidates[0]

    def download_audio(self, url: str, workspace: Path) -> Path:
        try:
            from yt_dlp import YoutubeDL
        except ImportError as error:
            raise WorkerError(
                "YTDLP_NOT_READY",
                "yt-dlp is not installed; run pnpm worker:install",
                retryable=True,
            ) from error

        workspace.mkdir(parents=True, exist_ok=True)
        options = {
            "ignoreconfig": True,
            "noplaylist": True,
            "format": "bestaudio[abr<=160]",
            "outtmpl": str(workspace / "audio.%(ext)s"),
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
        }
        try:
            with YoutubeDL(options) as downloader:
                result = downloader.download([url])
        except Exception as error:
            mapped = _yt_dlp_runtime_error(error)
            if mapped is not None:
                raise mapped from error
            raise WorkerError(
                "YOUTUBE_AUDIO_FETCH_FAILED",
                "Unable to download an audio-only YouTube stream",
                retryable=True,
            ) from error
        if result:
            raise WorkerError(
                "YOUTUBE_AUDIO_FETCH_FAILED",
                "Unable to download an audio-only YouTube stream",
                retryable=True,
            )
        candidates = [
            path
            for path in workspace.glob("audio.*")
            if path.is_file() and path.suffix.lower() not in {".part", ".ytdl"}
        ]
        if len(candidates) != 1:
            raise WorkerError(
                "YOUTUBE_AUDIO_FETCH_FAILED",
                "Audio-only YouTube stream was not written to the job workspace",
                retryable=True,
            )
        return candidates[0]


class YoutubeSourceResolver:
    def __init__(self, client: YoutubeClient | None = None) -> None:
        self._client = client or YoutubeDlClient()

    def resolve_caption(
        self, request: StartJobRequest, emit: EventCallback
    ) -> ResolvedTranscript:
        if not isinstance(request.source, YoutubeSource):
            raise WorkerError(
                "INVALID_REQUEST", "YouTube resolver requires a YouTube source", job_id=request.job_id
            )
        _emit_phase(emit, request.job_id, "resolving_source", 5.0)
        try:
            video = self._client.inspect(request.source.url)
        except WorkerError as error:
            raise _with_job_id(error, request.job_id) from error
        if video.is_live:
            raise WorkerError("YOUTUBE_LIVE_UNSUPPORTED", "Live YouTube videos are not supported", job_id=request.job_id)
        language = _explicit_source_language(request)
        tracks = rank_caption_tracks(video, language)
        if not tracks:
            raise WorkerError(
                "YOUTUBE_CAPTION_UNAVAILABLE",
                "No usable caption is available for the selected source language",
                job_id=request.job_id,
            )
        _emit_phase(emit, request.job_id, "fetching_subtitles", 25.0)
        for track in tracks:
            try:
                path = self._client.download_caption(
                    request.source.url, track, request.workspace_path
                )
            except WorkerError as error:
                raise _with_job_id(error, request.job_id) from error
            segments = parse_caption(path, request.job_id)
            if segments:
                emit(
                    {
                        "type": "progress",
                        "jobId": request.job_id,
                        "phase": "fetching_subtitles",
                        "percent": 40.0,
                    }
                )
                return ResolvedTranscript(
                    segments=segments,
                    output_stem=f"{sanitize_output_stem(video.title, video.video_id)}.vi",
                    source_language=language,
                      transcript_language=language,
                      origin="automatic_caption" if track.automatic else "manual_caption",
                      display_title=sanitize_display_title(video.title),
                )
        raise WorkerError(
            "YOUTUBE_CAPTION_UNAVAILABLE",
            "No usable caption is available for the selected source language",
            job_id=request.job_id,
        )

    def resolve_audio(self, request: StartJobRequest, engine: Any, emit: EventCallback) -> ResolvedTranscript:
        if not isinstance(request.source, YoutubeSource):
            raise WorkerError(
                "INVALID_REQUEST", "YouTube resolver requires a YouTube source", job_id=request.job_id
            )
        _emit_phase(emit, request.job_id, "resolving_source", 5.0)
        try:
            video = self._client.inspect(request.source.url)
        except WorkerError as error:
            raise _with_job_id(error, request.job_id) from error
        if video.is_live:
            raise WorkerError("YOUTUBE_LIVE_UNSUPPORTED", "Live YouTube videos are not supported", job_id=request.job_id)
        _enforce_audio_guards(video, request.workspace_path, request.job_id)
        _emit_phase(emit, request.job_id, "downloading_audio", 45.0)
        try:
            audio_path = self._client.download_audio(request.source.url, request.workspace_path)
        except WorkerError as error:
            raise _with_job_id(error, request.job_id) from error

        segments, language, origin = engine.transcribe_youtube_audio(
            request,
            audio_path,
            source_language=request.source_language,
            emit=emit,
        )
        if not segments:
            raise WorkerError(
                "TRANSCRIPTION_FAILED", "Whisper returned no subtitle segments", job_id=request.job_id
            )
        return ResolvedTranscript(
            segments=segments,
            output_stem=f"{sanitize_output_stem(video.title, video.video_id)}.vi",
            source_language=language,
            transcript_language=language,
            origin=origin,
            display_title=sanitize_display_title(video.title),
        )


def rank_caption_tracks(video: YoutubeVideo, language: str) -> list[CaptionTrack]:
    matching_manual = [
        track
        for code, tracks in video.subtitles.items()
        if _language_matches(code, language)
        for track in tracks
    ]
    matching_automatic = [
        track
        for code, tracks in video.automatic_captions.items()
        if _language_matches(code, language)
        for track in tracks
    ]
    return [*matching_manual, *matching_automatic]


def parse_caption(path: Path, job_id: str) -> list[Segment]:
    try:
        import pysubs2

        subtitles = pysubs2.load(str(path), encoding="utf-8")
    except Exception as error:
        raise WorkerError(
            "YOUTUBE_CAPTION_INVALID",
            "Selected YouTube caption cannot be parsed",
            job_id=job_id,
        ) from error
    segments: list[Segment] = []
    for item in subtitles:
        text = item.plaintext.strip()
        start = item.start / 1000
        end = item.end / 1000
        if text and start >= 0 and end > start:
            segments.append(Segment(id=len(segments), start=start, end=end, text=text))
    return segments


def sanitize_output_stem(title: str, video_id: str) -> str:
    return f"{sanitize_display_title(title)}-{video_id}"


def sanitize_display_title(title: str) -> str:
    normalized = unicodedata.normalize("NFKC", title)
    cleaned = "".join(
        character if character.isalnum() or character in {" ", "-", "_"} else " "
        for character in normalized
    )
    return " ".join(cleaned.split()).strip(" .-_")[:80] or "youtube-video"


def _explicit_source_language(request: StartJobRequest) -> str:
    if request.source_language == "auto":
        raise WorkerError(
            "SOURCE_LANGUAGE_UNDETERMINED",
            "Choose Vietnamese or English before using a caption-only YouTube route",
            job_id=request.job_id,
        )
    return request.source_language


def _catalog(value: object, *, automatic: bool) -> dict[str, tuple[CaptionTrack, ...]]:
    if not isinstance(value, dict):
        return {}
    catalog: dict[str, tuple[CaptionTrack, ...]] = {}
    for language, entries in value.items():
        if not isinstance(language, str) or not isinstance(entries, list):
            continue
        tracks = tuple(
            CaptionTrack(
                language=language,
                automatic=automatic,
                extension=entry.get("ext") if isinstance(entry.get("ext"), str) else None,
            )
            for entry in entries
            if isinstance(entry, dict) and isinstance(entry.get("url"), str)
        )
        if tracks:
            catalog[language] = tracks
    return catalog


def _language_matches(candidate: str, expected: str) -> bool:
    return candidate.lower().split("-", maxsplit=1)[0] == expected


def _safe_video_id(value: str) -> bool:
    return 6 <= len(value) <= 32 and all(
        character.isascii() and (character.isalnum() or character in {"-", "_"})
        for character in value
    )


def _duration(value: object) -> float | None:
    if isinstance(value, (int, float)) and 0 < float(value) <= 86_400:
        return float(value)
    return None


def _yt_dlp_runtime_error(error: Exception) -> WorkerError | None:
    """Map yt-dlp's conditional JavaScript-runtime errors to a local action."""

    detail = str(error).lower()
    markers = ("javascript runtime", "js runtime", "deno", "yt-dlp-ejs")
    if not any(marker in detail for marker in markers):
        return None
    if shutil.which("deno") is None:
        return WorkerError(
            "YTDLP_JS_RUNTIME_NOT_READY",
            "yt-dlp needs the local Deno JavaScript runtime for this video",
            retryable=True,
        )
    return WorkerError(
        "YTDLP_JS_RUNTIME_FAILED",
        "yt-dlp JavaScript runtime could not process this video",
        retryable=True,
    )


def _enforce_audio_guards(video: YoutubeVideo, workspace: Path, job_id: str) -> None:
    if video.duration_seconds is None:
        raise WorkerError(
            "YOUTUBE_DURATION_UNKNOWN",
            "Video duration is unavailable; audio fallback was not started",
            job_id=job_id,
        )
    if video.duration_seconds > 4 * 60 * 60:
        raise WorkerError(
            "YOUTUBE_DURATION_EXCEEDED",
            "Video is longer than the four-hour audio fallback limit",
            job_id=job_id,
        )
    estimated_audio_bytes = int(video.duration_seconds * 160_000 / 8)
    required_free_bytes = max(
        int(1.5 * 1024**3), 2 * estimated_audio_bytes + 512 * 1024**2
    )
    try:
        available_bytes = shutil.disk_usage(workspace).free
    except OSError as error:
        raise WorkerError(
            "YOUTUBE_DISK_CHECK_FAILED",
            "Unable to verify free disk space for audio fallback",
            job_id=job_id,
            retryable=True,
        ) from error
    if available_bytes < required_free_bytes:
        raise WorkerError(
            "YOUTUBE_DISK_INSUFFICIENT",
            "Not enough free disk space for audio fallback",
            job_id=job_id,
        )


def _emit_phase(emit: EventCallback, job_id: str, phase: str, percent: float) -> None:
    emit({"type": "phase_changed", "jobId": job_id, "phase": phase})
    emit({"type": "progress", "jobId": job_id, "phase": phase, "percent": percent})


def _with_job_id(error: WorkerError, job_id: str) -> WorkerError:
    if error.job_id == job_id:
        return error
    return WorkerError(error.code, str(error), job_id=job_id, retryable=error.retryable)
