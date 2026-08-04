import type {
  JobOptions,
  QueuedJob,
  StartJobRequest,
} from "../../lib/types";
import { getOutputLocationReadiness } from "./outputLocation";
import { getTargetLanguageReadiness } from "./targetLanguage";

export function buildStartJobRequest(
  job: Pick<QueuedJob, "jobId" | "source">,
  options: JobOptions,
): StartJobRequest {
  const isYoutube = job.source.kind === "youtube";
  const youtubeDirectVietnamese = isYoutube && options.sourceLanguage === "vi";
  if (isYoutube && !youtubeDirectVietnamese && options.translationProvider !== "gemini") {
    throw new Error("YouTube tiếng Anh hoặc tự nhận diện cần dùng Gemini cho batch này.");
  }
  const translationOptions = isYoutube
    ? { ...options, targetLanguage: "vi" as const }
    : options;
  const readiness = youtubeDirectVietnamese
    ? { ready: true, reason: "" }
    : getTargetLanguageReadiness(translationOptions);
  if (!readiness.ready) throw new Error(readiness.reason);
  const outputReadiness = getOutputLocationReadiness(options);
  if (!outputReadiness.ready) throw new Error(outputReadiness.reason);
  if (isYoutube && options.outputLocationMode !== "custom_directory") {
    throw new Error("YouTube cần một thư mục lưu phụ đề riêng.");
  }
  const translating = isYoutube ? !youtubeDirectVietnamese : options.targetLanguage !== "none";

  return {
    type: "start_job",
    jobId: job.jobId,
    source: job.source,
    outputLocationMode: options.outputLocationMode,
    outputDirectory:
      options.outputLocationMode === "custom_directory"
        ? options.outputDirectory
        : null,
    model: options.model,
    sourceLanguage: options.sourceLanguage,
      targetLanguage: isYoutube ? "vi" : options.targetLanguage,
    task: "transcribe",
      translationProvider: translating
        ? `${options.translationProvider}_api`
        : "none",
    translationMode: translating ? "technical_context" : "none",
    technicalTranslation: translating,
    glossary: translating ? "software-engineering-default" : null,
    providerAccountFile: translating ? options.providerAccountFile : null,
    providerModel: translating ? options.providerModel.trim() : null,
    translationConsent: translating && options.translationConsent,
    device: options.device,
    outputFormats: options.includeVtt ? ["srt", "vtt"] : ["srt"],
    overwritePolicy: "suffix",
  };
}

export const buildLocalStartJobRequest = buildStartJobRequest;
