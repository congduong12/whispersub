import type { JobOptions, QueuedJob, StartJobRequest } from "../../lib/types";
import { isJobActive } from "./jobReducer";

export interface CurrentBatchPolicy {
  hasYoutube: boolean;
  requiresGemini: boolean;
  targetLanguage: StartJobRequest["targetLanguage"];
}

function isCurrentBatchJob(job: QueuedJob): boolean {
  return job.status === "queued" || isJobActive(job);
}

export function getCurrentBatchPolicy(
  jobs: QueuedJob[],
  options: Pick<JobOptions, "sourceLanguage" | "targetLanguage">,
): CurrentBatchPolicy {
  const hasYoutube = jobs.some(
    (job) => isCurrentBatchJob(job) && job.source.kind === "youtube",
  );
  const requiresGemini = hasYoutube && options.sourceLanguage !== "vi";

  return {
    hasYoutube,
    requiresGemini,
    targetLanguage: requiresGemini ? "vi" : options.targetLanguage,
  };
}

export function applyRequiredGemini(
  options: JobOptions,
  requiresGemini: boolean,
): JobOptions {
  if (!requiresGemini || options.translationProvider === "gemini") return options;
  return {
    ...options,
    translationProvider: "gemini",
    providerAccountFile: null,
    providerModel: "",
    translationConsent: false,
  };
}
