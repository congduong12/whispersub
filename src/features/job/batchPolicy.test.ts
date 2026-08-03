import { describe, expect, it } from "vitest";
import type { JobOptions, JobStatus, QueuedJob } from "../../lib/types";
import { applyRequiredGemini, getCurrentBatchPolicy } from "./batchPolicy";

const options: JobOptions = {
  model: "small",
  sourceLanguage: "auto",
  targetLanguage: "vi",
  translationProvider: "openai",
  providerAccountFile: "openai-work.json",
  providerModel: "gpt-5.6-luna",
  translationConsent: true,
  device: "auto",
  includeVtt: false,
  outputLocationMode: "custom_directory",
  outputDirectory: "/tmp/subtitles",
};

function job(
  jobId: string,
  status: JobStatus,
  kind: "local_file" | "youtube",
): QueuedJob {
  return {
    jobId,
    source:
      kind === "youtube"
        ? { kind, url: `https://youtu.be/${jobId}` }
        : { kind, inputPath: `/tmp/${jobId}.mp4` },
    fileName: jobId,
    status,
    progress: 0,
    segments: [],
    outputs: [],
    error: null,
    errorCode: null,
  };
}

describe("getCurrentBatchPolicy", () => {
  it("ignores terminal YouTube history", () => {
    const policy = getCurrentBatchPolicy(
      [job("old", "completed", "youtube"), job("next", "queued", "local_file")],
      options,
    );

    expect(policy.hasYoutube).toBe(false);
    expect(policy.requiresGemini).toBe(false);
  });

  it.each(["queued", "transcribing"] satisfies JobStatus[])(
    "locks a current %s YouTube auto job to Gemini",
    (status) => {
      const policy = getCurrentBatchPolicy([job("current", status, "youtube")], options);

      expect(policy.hasYoutube).toBe(true);
      expect(policy.requiresGemini).toBe(true);
      expect(policy.targetLanguage).toBe("vi");
    },
  );

  it("does not require Gemini for direct Vietnamese YouTube", () => {
    const policy = getCurrentBatchPolicy([job("vi", "queued", "youtube")], {
      ...options,
      sourceLanguage: "vi",
      targetLanguage: "none",
    });

    expect(policy.hasYoutube).toBe(true);
    expect(policy.requiresGemini).toBe(false);
    expect(policy.targetLanguage).toBe("none");
  });

  it("clears provider-specific values when the batch switches to Gemini", () => {
    expect(applyRequiredGemini(options, true)).toMatchObject({
      translationProvider: "gemini",
      providerAccountFile: null,
      providerModel: "",
      translationConsent: false,
    });
  });
});
