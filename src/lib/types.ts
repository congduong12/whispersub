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
  | "resolving_source"
  | "detecting_language"
  | "fetching_subtitles"
  | "downloading_audio"
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

export interface YoutubeLibrarySummary {
  videoId: string;
  displayTitle: string;
  updatedAt: string;
  versionCount: number;
}

export interface YoutubeLibraryVersion {
  recipeFingerprint: string;
  createdAt: string;
  sourceLanguage: "en" | "vi";
  transcriptOrigin: string;
  exports: Array<{ path: string; available: boolean }>;
  segments: SubtitleSegment[];
  segmentsSha256: string;
}

export interface YoutubeLibraryDetail extends Omit<YoutubeLibrarySummary, "versionCount"> {
  versions: YoutubeLibraryVersion[];
}

export type JobSource =
  | { kind: "local_file"; inputPath: string }
  | { kind: "youtube"; url: string };

export interface StartJobRequest {
  type: "start_job";
  jobId: string;
  source: JobSource;
  outputLocationMode: OutputLocationMode;
  outputDirectory: string | null;
  model: "tiny" | "base" | "small" | "medium" | "turbo";
  sourceLanguage: "auto" | "en" | "vi";
  targetLanguage: "none" | "en" | "vi";
  task: "transcribe";
    translationProvider: "none" | "openai_api" | "gemini_api";
  translationMode: "none" | "native_whisper" | "technical_context";
  technicalTranslation: boolean;
  glossary: string | null;
  providerAccountFile: string | null;
  providerModel: string | null;
  translationConsent: boolean;
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
  | {
      type: "source_resolved";
      jobId: string;
      displayTitle: string;
        transcriptOrigin:
        | "manual_caption"
        | "automatic_caption"
        | "whisper_transcribe"
        | "whisper_translate_to_english";
        sourceLanguage: "en" | "vi";
        cacheHit: boolean;
      }
    | {
        type: "completed";
        jobId: string;
        outputs: string[];
          cacheStatus?: "hit" | "stored" | "unavailable";
          libraryStatus?: "stored" | "unavailable";
      }
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
  source: JobSource;
  fileName: string;
  status: JobStatus;
  progress: number;
  segments: SubtitleSegment[];
  outputs: string[];
  error: string | null;
  errorCode: string | null;
  provenance?: {
    displayTitle: string;
      origin: Extract<JobEvent, { type: "source_resolved" }>["transcriptOrigin"];
      sourceLanguage: "en" | "vi";
      cacheHit: boolean;
    };
    cacheStatus?: Extract<JobEvent, { type: "completed" }>["cacheStatus"];
    libraryStatus?: Extract<JobEvent, { type: "completed" }>["libraryStatus"];
  }

export interface LocalStorageInfo {
  outputDirectory: string;
  defaultOutputDirectory: string;
  usesCustomOutputDirectory: boolean;
}

export interface JobOptions {
  model: StartJobRequest["model"];
  sourceLanguage: StartJobRequest["sourceLanguage"];
  targetLanguage: StartJobRequest["targetLanguage"];
  translationProvider: Provider;
  providerAccountFile: string | null;
  providerModel: string;
  translationConsent: boolean;
  device: StartJobRequest["device"];
  includeVtt: boolean;
  outputLocationMode: OutputLocationMode;
  outputDirectory: string | null;
}

export type OutputLocationMode = "same_as_input" | "custom_directory";

export type OutputLocationValidationCode =
  | "NO_INPUTS"
  | "INVALID_MODE"
  | "DIRECTORY_REQUIRED"
  | "DIRECTORY_NOT_ABSOLUTE"
  | "INPUT_NOT_FOUND"
  | "DIRECTORY_NOT_FOUND"
  | "DIRECTORY_NOT_WRITABLE";

export interface OutputLocationValidationResult {
  valid: boolean;
  code: OutputLocationValidationCode | null;
  path: string | null;
}

export type Provider = "openai" | "gemini";

export interface ProviderAccountSummary {
  fileName: string;
  label: string;
  provider: Provider;
  baseUrl: string;
  isActive: boolean;
}

export interface ProviderAccountState {
  accounts: ProviderAccountSummary[];
  activeAccountFile: string | null;
  warnings: string[];
}

export interface ProviderModelSummary {
  id: string;
  displayName: string | null;
}

export interface ProviderConnectionTestResult {
  outcome: "connected" | "rate_limited";
  message: string;
}
