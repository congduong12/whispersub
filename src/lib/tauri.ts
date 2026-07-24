import type {
  JobEvent,
  OutputLocationValidationResult,
  Provider,
  ProviderAccountState,
    ProviderAccountSummary,
    ProviderConnectionTestResult,
    ProviderModelSummary,
  StartJobRequest,
} from "./types";
import { normalizeProviderBaseUrl } from "./providerAccounts";

export const JOB_EVENT_NAME = "whispersub://job-event";

type Unlisten = () => void;
type JobListener = (event: JobEvent) => void;

const browserListeners = new Set<JobListener>();
const browserTimers = new Map<string, number[]>();
let browserProviderAccounts: ProviderAccountSummary[] = [];
const browserActiveAccount: Record<Provider, string | null> = {
  openai: null,
  gemini: null,
};

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function emitBrowserEvent(event: JobEvent): void {
  browserListeners.forEach((listener) => listener(event));
}

function scheduleBrowserMock(request: StartJobRequest): void {
  const translating = request.targetLanguage !== "none";
  const inputStem = request.inputPath
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.[^/.]+$/, "");
  const outputDirectory =
    request.outputLocationMode === "custom_directory" && request.outputDirectory
      ? request.outputDirectory.replace(/[\\/]+$/, "")
      : request.inputPath.replace(/[\\/][^\\/]+$/, "");
  const outputBase = `${outputDirectory}/${inputStem ?? "subtitle"}${
    translating ? `.${request.targetLanguage}` : ""
  }`;
  const events: Array<[number, JobEvent]> = [
    [0, { type: "job_started", jobId: request.jobId }],
    [250, { type: "phase_changed", jobId: request.jobId, phase: "loading_model" }],
    [500, { type: "progress", jobId: request.jobId, phase: "loading_model", percent: 18 }],
    [800, { type: "phase_changed", jobId: request.jobId, phase: "extracting_audio" }],
    [1100, { type: "progress", jobId: request.jobId, phase: "extracting_audio", percent: 31 }],
    [1400, { type: "phase_changed", jobId: request.jobId, phase: "transcribing" }],
    [1750, { type: "progress", jobId: request.jobId, phase: "transcribing", percent: 56 }],
    [2050, {
      type: "segment",
      jobId: request.jobId,
      segment: { id: 0, start: 0.12, end: 3.84, text: "WhisperSub đang chạy bằng mock worker." },
    }],
    [2350, { type: "progress", jobId: request.jobId, phase: "transcribing", percent: 84 }],
    ...(translating
      ? ([
          [2650, { type: "phase_changed", jobId: request.jobId, phase: "translating" }],
          [2850, { type: "progress", jobId: request.jobId, phase: "translating", percent: 94 }],
        ] satisfies Array<[number, JobEvent]>)
      : []),
    [translating ? 3100 : 2650, { type: "phase_changed", jobId: request.jobId, phase: "writing_output" }],
    [translating ? 3400 : 2950, {
      type: "completed",
      jobId: request.jobId,
      outputs: [`${outputBase}.srt`],
    }],
  ];

  const timers = events.map(([delay, event]) =>
    window.setTimeout(() => emitBrowserEvent(event), delay),
  );
  browserTimers.set(request.jobId, timers);
}

export async function listenJobEvents(listener: JobListener): Promise<Unlisten> {
  if (!isTauriRuntime()) {
    browserListeners.add(listener);
    return () => browserListeners.delete(listener);
  }

  const { listen } = await import("@tauri-apps/api/event");
  return listen<JobEvent>(JOB_EVENT_NAME, ({ payload }) => listener(payload));
}

export async function startJob(request: StartJobRequest): Promise<void> {
  if (!isTauriRuntime()) {
    scheduleBrowserMock(request);
    return;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("start_transcription_job", { request });
}

export async function cancelJob(jobId: string): Promise<void> {
  if (!isTauriRuntime()) {
    browserTimers.get(jobId)?.forEach((timer) => window.clearTimeout(timer));
    browserTimers.delete(jobId);
    emitBrowserEvent({ type: "cancelled", jobId });
    return;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("cancel_transcription_job", { jobId });
}

function browserProviderAccountState(provider: Provider): ProviderAccountState {
  return {
    accounts: browserProviderAccounts
      .filter((account) => account.provider === provider)
      .map((account) => ({
        ...account,
        isActive: account.fileName === browserActiveAccount[provider],
      })),
    activeAccountFile: browserActiveAccount[provider],
    warnings: [],
  };
}

function browserAccountSlug(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/đ/g, "d")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return slug || "account";
}

function validateBrowserAccountInput(label: string, apiKey?: string): void {
  const labelLength = [...label.trim()].length;
  if (!labelLength) throw new Error("validation: Hãy nhập tên hiển thị cho account.");
  if (labelLength > 64) {
    throw new Error("validation: Tên hiển thị không được dài hơn 64 ký tự.");
  }
  if (apiKey !== undefined && apiKey.trim().length < 8) {
    throw new Error("validation: API key quá ngắn hoặc đang để trống.");
  }
}

export async function listProviderAccounts(provider: Provider): Promise<ProviderAccountState> {
  if (!isTauriRuntime()) return browserProviderAccountState(provider);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ProviderAccountState>("list_provider_accounts", { provider });
}

export async function listProviderModels(
  provider: Provider,
  fileName: string,
): Promise<ProviderModelSummary[]> {
  if (!isTauriRuntime()) {
    const accountExists = browserProviderAccounts.some(
      (account) => account.provider === provider && account.fileName === fileName,
    );
    if (!accountExists) throw new Error(`not_found: Không tìm thấy account ${fileName}.`);
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    return provider === "gemini"
      ? [
          { id: "gemini-3.1-flash-lite", displayName: "Gemini 3.1 Flash Lite" },
          { id: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash" },
          { id: "gemini-flash-lite-latest", displayName: "Gemini Flash-Lite Latest" },
          { id: "gemini-flash-latest", displayName: "Gemini Flash Latest" },
          { id: "gemma-4-26b-a4b-it", displayName: "Gemma 4 26B A4B IT" },
          { id: "gemma-4-31b-it", displayName: "Gemma 4 31B IT" },
          { id: "gemini-3-flash-preview", displayName: "Gemini 3 Flash Preview" },
          { id: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro Preview" },
          { id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
        ]
      : [
          { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna" },
          { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra" },
          { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
        ];
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ProviderModelSummary[]>("list_provider_models", { provider, fileName });
}

export async function createProviderAccount(
  provider: Provider,
  label: string,
  apiKey: string,
  baseUrl: string,
): Promise<ProviderAccountState> {
  if (!isTauriRuntime()) {
    validateBrowserAccountInput(label, apiKey);
    const normalizedBaseUrl = normalizeProviderBaseUrl(provider, baseUrl);
    const slug = browserAccountSlug(label);
    let suffix = 1;
    while (
      browserProviderAccounts.some(
        (account) => account.fileName === `${provider}_${slug}_${suffix}.json`,
      )
    ) {
      suffix += 1;
    }
    const fileName = `${provider}_${slug}_${suffix}.json`;
    browserProviderAccounts = [
      ...browserProviderAccounts,
      {
        fileName,
        label: label.trim(),
        provider,
        baseUrl: normalizedBaseUrl,
        isActive: false,
      },
    ].sort((left, right) => left.label.localeCompare(right.label));
    browserActiveAccount[provider] ??= fileName;
    return browserProviderAccountState(provider);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ProviderAccountState>("create_provider_account", {
    provider,
    label,
    apiKey,
    baseUrl,
  });
}

export async function updateProviderAccount(
  provider: Provider,
  fileName: string,
  label: string,
  apiKey?: string,
  baseUrl = "",
): Promise<ProviderAccountState> {
  if (!isTauriRuntime()) {
    validateBrowserAccountInput(label, apiKey?.trim() ? apiKey : undefined);
    const normalizedBaseUrl = normalizeProviderBaseUrl(provider, baseUrl);
    const account = browserProviderAccounts.find(
      (candidate) => candidate.provider === provider && candidate.fileName === fileName,
    );
    if (!account) throw new Error(`not_found: Không tìm thấy account ${fileName}.`);
    browserProviderAccounts = browserProviderAccounts
      .map((candidate) =>
          candidate.fileName === fileName
            ? { ...candidate, label: label.trim(), baseUrl: normalizedBaseUrl }
            : candidate,
      )
      .sort((left, right) => left.label.localeCompare(right.label));
    return browserProviderAccountState(provider);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ProviderAccountState>("update_provider_account", {
    provider,
    fileName,
    label,
    apiKey: apiKey?.trim() ? apiKey : null,
    baseUrl,
  });
}

export async function setActiveProviderAccount(
  provider: Provider,
  fileName: string,
): Promise<ProviderAccountState> {
  if (!isTauriRuntime()) {
    if (
      !browserProviderAccounts.some(
        (account) => account.provider === provider && account.fileName === fileName,
      )
    ) {
      throw new Error(`not_found: Không tìm thấy account ${fileName}.`);
    }
    browserActiveAccount[provider] = fileName;
    return browserProviderAccountState(provider);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ProviderAccountState>("set_active_provider_account", { provider, fileName });
}

export async function deleteProviderAccount(
  provider: Provider,
  fileName: string,
): Promise<ProviderAccountState> {
  if (!isTauriRuntime()) {
    if (
      !browserProviderAccounts.some(
        (account) => account.provider === provider && account.fileName === fileName,
      )
    ) {
      throw new Error(`not_found: Không tìm thấy account ${fileName}.`);
    }
    browserProviderAccounts = browserProviderAccounts.filter(
      (account) => account.fileName !== fileName,
    );
    if (browserActiveAccount[provider] === fileName) browserActiveAccount[provider] = null;
    return browserProviderAccountState(provider);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ProviderAccountState>("delete_provider_account", { provider, fileName });
}

export async function testProviderConnection(
  provider: Provider,
  apiKey: string,
  baseUrl: string,
  fileName?: string,
): Promise<ProviderConnectionTestResult> {
  if (!isTauriRuntime()) {
    const normalizedBaseUrl = normalizeProviderBaseUrl(provider, baseUrl);
    const candidate = apiKey.trim();
    if (!candidate && !fileName) {
      throw new Error("validation: Hãy nhập API key trước khi kiểm tra.");
    }
    if (candidate) validateBrowserAccountInput("Connection test", candidate);
    if (
      fileName
      && !candidate
      && !browserProviderAccounts.some(
        (account) => account.provider === provider && account.fileName === fileName,
      )
    ) {
      throw new Error(`not_found: Không tìm thấy account ${fileName}.`);
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    if (candidate.toLowerCase().includes("invalid")) {
      throw new Error("connection: API key không hợp lệ hoặc đã bị thu hồi.");
    }
    if (normalizedBaseUrl.includes("rate-limit")) {
      return {
        outcome: "rate_limited",
        message: "Provider đã phản hồi nhưng đang giới hạn tần suất hoặc quota. Chưa thể xác nhận chắc chắn API key.",
      };
    }
    return {
      outcome: "connected",
      message: "Kết nối thành công. Provider đã chấp nhận API key.",
    };
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ProviderConnectionTestResult>("test_provider_connection", {
    provider,
    apiKey: apiKey.trim() ? apiKey : null,
    baseUrl,
    fileName: fileName ?? null,
  });
}

export async function chooseVideoPaths(): Promise<string[]> {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selection = await open({
      multiple: true,
      directory: false,
      filters: [
        {
          name: "Video & audio",
          extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v", "mp3", "wav", "m4a"],
        },
      ],
    });
    if (!selection) return [];
    return Array.isArray(selection) ? selection : [selection];
  }

  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "video/*,audio/*";
    input.onchange = () => {
      resolve(
        Array.from(input.files ?? []).map(
          (file) => `/browser-preview/${file.name}`,
        ),
      );
    };
    input.click();
  });
}

export async function chooseOutputDirectory(): Promise<string | null> {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selection = await open({
      title: "Chọn thư mục lưu phụ đề",
      multiple: false,
      directory: true,
    });
    if (!selection) return null;
    return Array.isArray(selection) ? (selection[0] ?? null) : selection;
  }

  return "/browser-preview/Subtitles";
}

export async function validateOutputLocations(
  inputPaths: string[],
  outputLocationMode: StartJobRequest["outputLocationMode"],
  outputDirectory: string | null,
): Promise<OutputLocationValidationResult> {
  if (!isTauriRuntime()) {
    if (inputPaths.length === 0) {
      return { valid: false, code: "NO_INPUTS", path: null };
    }
    if (outputLocationMode === "custom_directory" && !outputDirectory?.trim()) {
      return { valid: false, code: "DIRECTORY_REQUIRED", path: null };
    }
    return { valid: true, code: null, path: null };
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<OutputLocationValidationResult>("validate_output_locations", {
    request: {
      inputPaths,
      outputLocationMode,
      outputDirectory,
    },
  });
}

export async function listenForFileDrops(
  listener: (paths: string[]) => void,
): Promise<Unlisten> {
  if (isTauriRuntime()) {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    return getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") listener(event.payload.paths);
    });
  }

  const prevent = (event: DragEvent) => event.preventDefault();
  const drop = (event: DragEvent) => {
    event.preventDefault();
    const paths = Array.from(event.dataTransfer?.files ?? []).map(
      (file) => `/browser-preview/${file.name}`,
    );
    listener(paths);
  };
  window.addEventListener("dragover", prevent);
  window.addEventListener("drop", drop);
  return () => {
    window.removeEventListener("dragover", prevent);
    window.removeEventListener("drop", drop);
  };
}
