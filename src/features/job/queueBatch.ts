import type { QueuedJob } from "../../lib/types";

export function findNextValidatedQueuedJob(
  jobs: QueuedJob[],
  validatedJobIds: ReadonlySet<string>,
): QueuedJob | null {
  return (
    jobs.find(
      (job) =>
        job.status === "queued" && validatedJobIds.has(job.jobId),
    ) ?? null
  );
}
