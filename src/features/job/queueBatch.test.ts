import { describe, expect, it } from "vitest";
import type { JobStatus, QueuedJob } from "../../lib/types";
import { findNextValidatedQueuedJob } from "./queueBatch";

function makeJob(jobId: string, status: JobStatus): QueuedJob {
  return {
    jobId,
    source: { kind: "local_file", inputPath: `/video/${jobId}.mp4` },
    fileName: `${jobId}.mp4`,
    status,
    progress: 0,
    segments: [],
    outputs: [],
    error: null,
    errorCode: null,
  };
}

describe("findNextValidatedQueuedJob", () => {
  it("selects queued work from the preflighted batch", () => {
    const jobs = [
      makeJob("finished", "completed"),
      makeJob("validated", "queued"),
      makeJob("appended", "queued"),
    ];

    expect(
      findNextValidatedQueuedJob(jobs, new Set(["finished", "validated"])),
    ).toMatchObject({ jobId: "validated" });
  });

  it("leaves files appended during a run for the next preflight", () => {
    const jobs = [
      makeJob("finished", "completed"),
      makeJob("appended", "queued"),
    ];

    expect(
      findNextValidatedQueuedJob(jobs, new Set(["finished"])),
    ).toBeNull();
  });
});
