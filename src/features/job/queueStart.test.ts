import { describe, expect, it, vi } from "vitest";

import type { JobOptions, QueuedJob, StartJobRequest } from "../../lib/types";
import { jobReducer } from "./jobReducer";
import { findNextValidatedQueuedJob } from "./queueBatch";
import { createQueueStartAttempt } from "./queueStart";

const options: JobOptions = {
  model: "small",
  sourceLanguage: "auto",
  targetLanguage: "none",
  translationProvider: "openai",
  providerAccountFile: null,
  providerModel: "",
  translationConsent: false,
  device: "auto",
  includeVtt: false,
  outputLocationMode: "same_as_input",
  outputDirectory: null,
};

function queuedJob(jobId: string): QueuedJob {
  return {
    jobId,
    source: { kind: "local_file", inputPath: `/video/${jobId}.mp4` },
    fileName: `${jobId}.mp4`,
    status: "queued",
    progress: 0,
    segments: [],
    outputs: [],
    error: null,
    errorCode: null,
  };
}

describe("createQueueStartAttempt", () => {
  it("turns a synchronous request-build failure into a terminal non-retryable error without starting a worker", () => {
    const first = queuedJob("first");
    const buildRequest = vi.fn<
      (job: QueuedJob, currentOptions: JobOptions) => StartJobRequest
    >(() => {
      throw new Error("Missing output directory");
    });

    const attempt = createQueueStartAttempt(first, options, buildRequest);

    expect(attempt).toEqual({
      kind: "failed",
      event: {
        type: "error",
        jobId: "first",
        code: "START_REQUEST_INVALID",
        message: "Missing output directory",
        retryable: false,
      },
    });
    expect(buildRequest).toHaveBeenCalledOnce();
    if (attempt.kind !== "failed") throw new Error("Expected request build to fail");

    const jobsAfterFailure = jobReducer([first, queuedJob("second")], {
      type: "event_received",
      event: attempt.event,
    });
    expect(jobsAfterFailure.map((job) => job.status)).toEqual(["failed", "queued"]);

    const next = findNextValidatedQueuedJob(
      jobsAfterFailure,
      new Set(jobsAfterFailure.map((job) => job.jobId)),
    );
    const nextAttempt = createQueueStartAttempt(next!, options, (job) => ({
      type: "start_job",
      jobId: job.jobId,
      source: job.source,
      outputLocationMode: "same_as_input",
      outputDirectory: null,
      model: "small",
      sourceLanguage: "auto",
      targetLanguage: "none",
      task: "transcribe",
      translationProvider: "none",
      translationMode: "none",
      technicalTranslation: false,
      glossary: null,
      providerAccountFile: null,
      providerModel: null,
      translationConsent: false,
      device: "auto",
      outputFormats: ["srt"],
      overwritePolicy: "suffix",
    }));

    expect(next?.jobId).toBe("second");
    expect(nextAttempt).toMatchObject({ kind: "start", request: { jobId: "second" } });
  });
});
