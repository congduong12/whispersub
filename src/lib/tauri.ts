import type { JobEvent, StartJobRequest } from "./types";

export const JOB_EVENT_NAME = "whispersub://job-event";

type Unlisten = () => void;
type JobListener = (event: JobEvent) => void;

const browserListeners = new Set<JobListener>();
const browserTimers = new Map<string, number[]>();

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function emitBrowserEvent(event: JobEvent): void {
  browserListeners.forEach((listener) => listener(event));
}

function scheduleBrowserMock(request: StartJobRequest): void {
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
    [2650, { type: "phase_changed", jobId: request.jobId, phase: "writing_output" }],
    [2950, {
      type: "completed",
      jobId: request.jobId,
      outputs: [`${request.inputPath.replace(/\.[^/.]+$/, "")}.srt`],
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
