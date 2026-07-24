import type {
  JobOptions,
  QueuedJob,
  StartJobRequest,
} from "../../lib/types";
import { getOutputLocationReadiness } from "./outputLocation";
import { getTargetLanguageReadiness } from "./targetLanguage";

export function buildLocalStartJobRequest(
  job: Pick<QueuedJob, "jobId" | "inputPath">,
  options: JobOptions,
): StartJobRequest {
  const readiness = getTargetLanguageReadiness(options);
  if (!readiness.ready) throw new Error(readiness.reason);
  const outputReadiness = getOutputLocationReadiness(options);
  if (!outputReadiness.ready) throw new Error(outputReadiness.reason);
  const translating = options.targetLanguage !== "none";

  return {
    type: "start_job",
    jobId: job.jobId,
    inputPath: job.inputPath,
    outputLocationMode: options.outputLocationMode,
    outputDirectory:
      options.outputLocationMode === "custom_directory"
        ? options.outputDirectory
        : null,
    model: options.model,
    sourceLanguage: options.sourceLanguage,
    targetLanguage: options.targetLanguage,
    task: "transcribe",
    translationProvider: translating ? `${options.translationProvider}_api` : "none",
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
