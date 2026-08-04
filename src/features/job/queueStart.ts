import type { JobEvent, JobOptions, QueuedJob, StartJobRequest } from "../../lib/types";

export type QueueStartAttempt =
  | { kind: "start"; request: StartJobRequest }
  | { kind: "failed"; event: Extract<JobEvent, { type: "error" }> };

export function createQueueStartAttempt(
  job: QueuedJob,
  options: JobOptions,
  buildRequest: (job: QueuedJob, options: JobOptions) => StartJobRequest,
): QueueStartAttempt {
  try {
    return { kind: "start", request: buildRequest(job, options) };
  } catch (cause) {
    return {
      kind: "failed",
      event: {
        type: "error",
        jobId: job.jobId,
        code: "START_REQUEST_INVALID",
        message: cause instanceof Error ? cause.message : String(cause),
        retryable: false,
      },
    };
  }
}
