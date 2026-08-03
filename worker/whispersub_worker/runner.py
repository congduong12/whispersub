from __future__ import annotations

from collections.abc import Callable

from worker.whispersub_worker.engine import EventCallback, TranscriptionEngine
from worker.whispersub_worker.protocol import StartJobRequest, WorkerError, YoutubeSource
from worker.whispersub_worker.subtitles import write_outputs
from worker.whispersub_worker.translation import TranslationProvider
from worker.whispersub_worker.youtube import YoutubeSourceResolver
from worker.whispersub_worker.youtube import ResolvedTranscript
from worker.whispersub_worker.youtube_cache import (
    CachedYoutubeTranscript,
    YoutubeTranscriptCache,
)
from worker.whispersub_worker.youtube_library import store_library_item


def run_job(
    request: StartJobRequest,
    engine: TranscriptionEngine,
    emit: EventCallback,
    *,
    translator: TranslationProvider | None = None,
    readiness_check: Callable[[StartJobRequest], None] | None = None,
    output_writer: Callable[..., list] = write_outputs,
    youtube_resolver: YoutubeSourceResolver | None = None,
) -> None:
    emit({"type": "job_started", "jobId": request.job_id})
    try:
        translated = request.translation_provider != "none"
        is_youtube = isinstance(request.source, YoutubeSource)

        def prepare_translation() -> None:
            if translator is None:
                raise WorkerError(
                    "TRANSLATION_PROVIDER_UNAVAILABLE",
                    "Translation adapter is not available",
                    job_id=request.job_id,
                    retryable=True,
                )
            if readiness_check is not None:
                readiness_check(request)

        if translated and not is_youtube:
            prepare_translation()

        output_stem: str | None = None
        cache: YoutubeTranscriptCache | None = None
        cached: CachedYoutubeTranscript | None = None
        resolved: ResolvedTranscript | None = None
        cache_status: str | None = None
        if is_youtube:
            assert request.youtube_cache_path is not None
            cache = YoutubeTranscriptCache(request.youtube_cache_path)
            cached = cache.load(request)
            if cached is not None:
                segments = cached.segments
                output_stem = cached.output_stem
                cache_status = "hit"
                display_title = cached.display_title
                transcript_origin = cached.origin
                transcript_language = cached.transcript_language
            else:
                if youtube_resolver is None:
                    raise WorkerError(
                        "YOUTUBE_RESOLVER_UNAVAILABLE",
                        "YouTube source support is not available",
                        job_id=request.job_id,
                        retryable=True,
                    )
                try:
                    resolved = youtube_resolver.resolve_caption(request, emit)
                except WorkerError as error:
                    if error.code not in {
                        "YOUTUBE_CAPTION_UNAVAILABLE",
                        "YOUTUBE_CAPTION_INVALID",
                        "SOURCE_LANGUAGE_UNDETERMINED",
                    }:
                        raise
                    resolved = youtube_resolver.resolve_audio(request, engine, emit)
                segments = resolved.segments
                output_stem = resolved.output_stem
                display_title = resolved.display_title
                transcript_origin = resolved.origin
                transcript_language = resolved.transcript_language
            emit(
                {
                    "type": "source_resolved",
                    "jobId": request.job_id,
                    "displayTitle": display_title,
                    "transcriptOrigin": transcript_origin,
                    "sourceLanguage": transcript_language,
                    "cacheHit": cached is not None,
                }
            )
            # A user may choose auto with a consented Gemini configuration, but
            # local detection can still resolve Vietnamese. In that case no
            # transcript is sent to the provider.
            translated = (
                cached is None
                and request.translation_provider != "none"
                and transcript_language != "vi"
            )
            if translated:
                prepare_translation()
        else:
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
        reusable_outputs = (
            cache.reusable_outputs(request, output_stem)
            if cache is not None and cached is not None and output_stem is not None
            else {}
        )
        if len(reusable_outputs) == len(request.output_formats):
            outputs = [
                reusable_outputs[output_format]
                for output_format in request.output_formats
            ]
        elif reusable_outputs:
            outputs = output_writer(
                request,
                segments,
                output_stem=output_stem,
                existing_outputs=reusable_outputs,
            )
        else:
            outputs = (
                output_writer(request, segments, output_stem=output_stem)
                if output_stem is not None
                else output_writer(request, segments)
            )
        if cache is not None:
            cache_resolved = resolved or ResolvedTranscript(
                segments=segments,
                output_stem=output_stem or "youtube-video.vi",
                source_language=cached.source_language if cached is not None else "vi",
                transcript_language=(
                    cached.transcript_language if cached is not None else "vi"
                ),
                origin=cached.origin if cached is not None else "whisper_transcribe",
                display_title=(
                    cached.display_title if cached is not None else "YouTube video"
                ),
            )
            try:
                cache.store(request, cache_resolved, segments, outputs)
                if cache_status is None:
                    cache_status = "stored"
            except WorkerError:
                if cache_status is None:
                    cache_status = "unavailable"
            library_status = "stored"
            try:
                store_library_item(request, cache_resolved, segments, outputs)
            except (OSError, ValueError):
                # Subtitle publication remains successful when optional durable history is unavailable.
                library_status = "unavailable"
        completed = {
            "type": "completed",
            "jobId": request.job_id,
            "outputs": [str(path) for path in outputs],
        }
        if cache_status is not None:
            completed["cacheStatus"] = cache_status
        if is_youtube:
            completed["libraryStatus"] = library_status
        emit(completed)
    except WorkerError:
        raise
    except Exception as error:
        raise WorkerError(
            "UNKNOWN_ERROR", str(error), job_id=request.job_id, retryable=True
        ) from error
