import type { QueuedJob } from "../../lib/types";

export function getAddedJobIds(
  previousJobIds: ReadonlySet<string>,
  jobs: QueuedJob[],
): string[] {
  return jobs
    .filter((job) => !previousJobIds.has(job.jobId))
    .map((job) => job.jobId);
}
