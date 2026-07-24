import { describe, expect, it } from "vitest";
import type { QueuedJob } from "../../lib/types";
import { getAddedJobIds } from "./queueReveal";

function makeJob(jobId: string): QueuedJob {
  return {
    jobId,
    inputPath: `/video/${jobId}.mp4`,
    fileName: `${jobId}.mp4`,
    status: "queued",
    progress: 0,
    segments: [],
    outputs: [],
    error: null,
    errorCode: null,
  };
}

describe("getAddedJobIds", () => {
  it("returns only appended job ids in queue order", () => {
    const previousJobIds = new Set(["job-1", "job-2"]);

    expect(
      getAddedJobIds(previousJobIds, [
        makeJob("job-1"),
        makeJob("job-2"),
        makeJob("job-3"),
        makeJob("job-4"),
      ]),
    ).toEqual(["job-3", "job-4"]);
  });

  it("does not report existing jobs when their status changes", () => {
    const previousJobIds = new Set(["job-1"]);
    const completedJob = { ...makeJob("job-1"), status: "completed" as const };

    expect(getAddedJobIds(previousJobIds, [completedJob])).toEqual([]);
  });
});
