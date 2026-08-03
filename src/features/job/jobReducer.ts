import type { JobEvent, JobStatus, QueuedJob } from "../../lib/types";

export type JobAction =
  | { type: "add_paths"; paths: string[] }
  | { type: "add_youtube"; url: string }
  | { type: "remove_job"; jobId: string }
  | { type: "mark_started"; jobId: string }
  | { type: "event_received"; event: JobEvent }
  | { type: "clear_finished" }
  | { type: "reset" };

const activeStatuses = new Set<JobStatus>([
  "preparing",
  "resolving_source",
  "detecting_language",
  "fetching_subtitles",
  "downloading_audio",
  "loading_model",
  "extracting_audio",
  "transcribing",
  "translating",
  "writing_output",
  "cancelling",
]);

const terminalStatuses = new Set<JobStatus>([
  "completed",
  "cancelled",
  "failed",
]);

export function isJobActive(job: QueuedJob): boolean {
  return activeStatuses.has(job.status);
}

export function isJobTerminal(job: QueuedJob): boolean {
  return terminalStatuses.has(job.status);
}

export function fileNameFromPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function createJob(path: string): QueuedJob {
  return {
    jobId: `job_${crypto.randomUUID()}`,
    source: { kind: "local_file", inputPath: path },
    fileName: fileNameFromPath(path),
    status: "queued",
    progress: 0,
    segments: [],
      outputs: [],
      error: null,
      errorCode: null,
  };
}

function createYoutubeJob(url: string): QueuedJob {
  const hostname = new URL(url).hostname.replace(/^www\./, "");
  return {
    jobId: `job_${crypto.randomUUID()}`,
    source: { kind: "youtube", url },
    fileName: `YouTube · ${hostname}`,
    status: "queued",
    progress: 0,
    segments: [],
    outputs: [],
    error: null,
    errorCode: null,
  };
}

function applyEvent(job: QueuedJob, event: JobEvent): QueuedJob {
  if (job.jobId !== event.jobId) return job;

  switch (event.type) {
    case "job_started":
      return { ...job, status: "preparing", progress: 1 };
    case "phase_changed":
      return { ...job, status: event.phase };
    case "progress":
      return {
        ...job,
        status: event.phase,
        progress: Math.min(100, Math.max(job.progress, event.percent)),
      };
      case "segment":
        return { ...job, segments: [...job.segments, event.segment] };
      case "source_resolved":
        return {
            ...job,
            provenance: {
              displayTitle: event.displayTitle,
                origin: event.transcriptOrigin,
                sourceLanguage: event.sourceLanguage,
                cacheHit: event.cacheHit,
            },
          fileName: event.displayTitle,
        };
    case "completed":
      return {
        ...job,
        status: "completed",
        progress: 100,
          outputs: event.outputs,
          cacheStatus: event.cacheStatus,
          libraryStatus: event.libraryStatus,
      };
    case "cancelled":
      return { ...job, status: "cancelled" };
      case "error":
        return {
          ...job,
          status: "failed",
          error: event.message,
          errorCode: event.code,
        };
  }
}

export function jobReducer(state: QueuedJob[], action: JobAction): QueuedJob[] {
  switch (action.type) {
      case "add_paths": {
        const knownPaths = new Set(
          state.flatMap((job) =>
            job.source.kind === "local_file" ? [job.source.inputPath] : [],
          ),
        );
      const additions = action.paths
        .filter((path) => {
          if (!path || knownPaths.has(path)) return false;
          knownPaths.add(path);
          return true;
        })
        .map(createJob);
        return [...state, ...additions];
      }
      case "add_youtube": {
        if (state.some((job) => job.source.kind === "youtube" && job.source.url === action.url)) {
          return state;
        }
        return [...state, createYoutubeJob(action.url)];
      }
    case "remove_job":
      return state.filter(
        (job) => job.jobId !== action.jobId || isJobActive(job),
      );
    case "mark_started":
      return state.map((job) =>
        job.jobId === action.jobId
          ? { ...job, status: "preparing", progress: 1 }
          : job,
      );
    case "event_received":
      return state.map((job) => applyEvent(job, action.event));
    case "clear_finished":
      return state.filter((job) => !isJobTerminal(job));
    case "reset":
      return [];
  }
}
