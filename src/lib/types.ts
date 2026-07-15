export const SUPPORTED_MEDIA_EXTENSIONS = [
  "mp4",
  "mov",
  "mkv",
  "webm",
  "avi",
  "m4v",
  "mp3",
  "wav",
  "m4a",
] as const;

export type JobStatus =
  | "queued"
  | "preparing"
  | "loading_model"
  | "extracting_audio"
  | "transcribing"
  | "translating"
  | "writing_output"
  | "completed"
  | "cancelling"
  | "cancelled"
  | "failed";

export type JobPhase = Exclude<JobStatus, "queued" | "cancelling" | "failed">;

export interface SubtitleSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

export interface StartJobRequest {
  type: "start_job";
  jobId: string;
  inputPath: string;
  outputLocationMode: "same_as_input" | "custom_directory";
  outputDirectory: string | null;
  model: "tiny" | "base" | "small" | "medium" | "turbo";
  sourceLanguage: "auto" | "en" | "vi";
  targetLanguage: "none" | "en" | "vi";
  task: "transcribe";
  translationProvider: "none" | "openai_api";
  translationMode: "none" | "native_whisper" | "technical_context";
  technicalTranslation: boolean;
  glossary: string | null;
  providerModel: string | null;
  device: "auto" | "mps" | "cpu";
  outputFormats: Array<"srt" | "vtt" | "json">;
  overwritePolicy: "ask" | "suffix" | "overwrite";
}

export type JobEvent =
  | { type: "job_started"; jobId: string }
  | { type: "phase_changed"; jobId: string; phase: JobPhase }
  | {
      type: "progress";
      jobId: string;
      phase: JobPhase;
      percent: number;
    }
  | { type: "segment"; jobId: string; segment: SubtitleSegment }
  | { type: "completed"; jobId: string; outputs: string[] }
  | { type: "cancelled"; jobId: string }
  | {
      type: "error";
      jobId: string;
      code: string;
      message: string;
      retryable: boolean;
    };

export interface QueuedJob {
  jobId: string;
  inputPath: string;
  fileName: string;
  status: JobStatus;
  progress: number;
  segments: SubtitleSegment[];
  outputs: string[];
  error: string | null;
}

export interface JobOptions {
  model: StartJobRequest["model"];
  sourceLanguage: StartJobRequest["sourceLanguage"];
  device: StartJobRequest["device"];
  includeVtt: boolean;
}
