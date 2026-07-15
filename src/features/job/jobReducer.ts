import type { JobEvent, JobStatus, QueuedJob } from "../../lib/types";

export type JobAction =
  | { type: "add_paths"; paths: string[] }
  | { type: "remove_job"; jobId: string }
  | { type: "mark_started"; jobId: string }
  | { type: "event_received"; event: JobEvent }
  | { type: "clear_finished" }
  | { type: "reset" };

const activeStatuses = new Set<JobStatus>([
  "preparing",
  "loading_model",
  "extracting_audio",
  "transcribing",
  "translating",
  "writing_output",
  "cancelling",
]);

export function isJobActive(job: QueuedJob): boolean {
  return activeStatuses.has(job.status);
}

export function fileNameFromPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function createJob(path: string): QueuedJob {
  return {
    jobId: `job_${crypto.randomUUID()}`,
    inputPath: path,
    fileName: fileNameFromPath(path),
    status: "queued",
    progress: 0,
    segments: [],
    outputs: [],
    error: null,
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
    case "completed":
      return {
        ...job,
        status: "completed",
        progress: 100,
        outputs: event.outputs,
      };
    case "cancelled":
      return { ...job, status: "cancelled" };
    case "error":
      return { ...job, status: "failed", error: event.message };
  }
}

export function jobReducer(state: QueuedJob[], action: JobAction): QueuedJob[] {
  switch (action.type) {
    case "add_paths": {
      const knownPaths = new Set(state.map((job) => job.inputPath));
      const additions = action.paths
        .filter((path) => {
          if (!path || knownPaths.has(path)) return false;
          knownPaths.add(path);
          return true;
        })
        .map(createJob);
      return [...state, ...additions];
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
      return state.filter(
        (job) => !["completed", "cancelled", "failed"].includes(job.status),
      );
    case "reset":
      return [];
  }
}
