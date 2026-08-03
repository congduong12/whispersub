import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  cancelJob,
  chooseOutputDirectory as openOutputDirectoryPicker,
  chooseVideoPaths,
  getLocalStorageInfo,
  listenForFileDrops,
  listenJobEvents,
  rememberOutputDirectory,
  startJob,
  validateOutputLocations,
} from "../../lib/tauri";
import type { JobOptions } from "../../lib/types";
import { applyRequiredGemini, getCurrentBatchPolicy } from "./batchPolicy";
import { isJobActive, jobReducer } from "./jobReducer";
import {
  getOutputLocationReadiness,
  getOutputLocationValidationMessage,
} from "./outputLocation";
import { findNextValidatedQueuedJob } from "./queueBatch";
import { createQueueStartAttempt } from "./queueStart";
import { buildStartJobRequest } from "./startJobRequest";
import { getTargetLanguageReadiness } from "./targetLanguage";
import { applyYoutubeOutputDefault } from "./youtubeOutput";

const defaultOptions: JobOptions = {
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

export function useJobQueue() {
  const [jobs, dispatch] = useReducer(jobReducer, []);
  const [options, setOptions] = useState<JobOptions>(defaultOptions);
  const [queueRunning, setQueueRunning] = useState(false);
  const [choosingOutputDirectory, setChoosingOutputDirectory] = useState(false);
  const [validatingOutputLocation, setValidatingOutputLocation] = useState(false);
  const [outputLocationError, setOutputLocationError] = useState<string | null>(null);
  const [preferredYoutubeOutputDirectory, setPreferredYoutubeOutputDirectory] =
    useState<string | null>(null);
  const validationLockedRef = useRef(false);
  const validatedBatchJobIdsRef = useRef<Set<string>>(new Set());

  const addPaths = useCallback((paths: string[]) => {
    if (validationLockedRef.current) return;
    dispatch({ type: "add_paths", paths });
    if (paths.length > 0) setOutputLocationError(null);
  }, []);

  const addYoutubeUrl = useCallback((value: string): string | null => {
    if (validationLockedRef.current) return "Hàng đợi đang được kiểm tra.";
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      return "Nhập URL YouTube HTTPS hợp lệ (youtube.com hoặc youtu.be).";
    }
    const host = url.hostname.toLowerCase();
    const allowed = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"];
    if (
      url.protocol !== "https:" ||
      !allowed.includes(host) ||
      url.username ||
      url.password
    ) {
      return "Nhập URL YouTube HTTPS hợp lệ (youtube.com hoặc youtu.be).";
    }
    const youtubeOptions = applyYoutubeOutputDefault(
      options,
      preferredYoutubeOutputDirectory,
    );
    if (!youtubeOptions) {
      return "WhisperSub chưa chuẩn bị được thư mục Documents mặc định. Hãy thử lại hoặc chọn thư mục lưu.";
    }
    setOptions(
      applyRequiredGemini(youtubeOptions, youtubeOptions.sourceLanguage !== "vi"),
    );
    dispatch({ type: "add_youtube", url: url.toString() });
    setOutputLocationError(null);
    return null;
  }, [options, preferredYoutubeOutputDirectory]);

  useEffect(() => {
    let disposed = false;
    void getLocalStorageInfo()
      .then((storage) => {
        if (disposed) return;
        setPreferredYoutubeOutputDirectory(storage.outputDirectory);
        setOptions((current) => ({
          ...current,
          outputDirectory: current.outputDirectory ?? storage.outputDirectory,
        }));
      })
      .catch(() => {
        if (!disposed) {
          setOutputLocationError(
            "Không thể chuẩn bị Documents/WhisperSub/Subtitles. Hãy chọn thư mục lưu thủ công.",
          );
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenJobEvents((event) => {
      dispatch({ type: "event_received", event });
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenForFileDrops(addPaths).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [addPaths]);

  const activeJob = useMemo(
    () => jobs.find(isJobActive) ?? null,
    [jobs],
  );

  const batchPolicy = useMemo(
    () => getCurrentBatchPolicy(jobs, options),
    [jobs, options],
  );
  const targetLanguageReadiness = useMemo(() => {
    if (batchPolicy.requiresGemini && options.translationProvider !== "gemini") {
      return {
        ready: false,
        reason: "YouTube tiếng Anh hoặc tự nhận diện cần dùng Gemini cho batch này.",
      };
    }
    return getTargetLanguageReadiness({
      ...options,
      targetLanguage: batchPolicy.targetLanguage,
    });
  }, [batchPolicy, options]);

  useEffect(() => {
    if (!batchPolicy.requiresGemini) return;
    setOptions((current) => applyRequiredGemini(current, true));
  }, [batchPolicy.requiresGemini]);

  useEffect(() => {
    if (!queueRunning || activeJob) return;
    const nextJob = findNextValidatedQueuedJob(
      jobs,
      validatedBatchJobIdsRef.current,
    );

    if (!nextJob) {
      validatedBatchJobIdsRef.current.clear();
      setQueueRunning(false);
      return;
    }
    if (!targetLanguageReadiness.ready) {
      validatedBatchJobIdsRef.current.clear();
      setQueueRunning(false);
      return;
    }

    const attempt = createQueueStartAttempt(nextJob, options, buildStartJobRequest);
    if (attempt.kind === "failed") {
      dispatch({ type: "event_received", event: attempt.event });
      return;
    }

    dispatch({ type: "mark_started", jobId: nextJob.jobId });
    void startJob(attempt.request).catch((error: unknown) => {
      dispatch({
        type: "event_received",
        event: {
          type: "error",
          jobId: nextJob.jobId,
          code: "WORKER_START_FAILED",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      });
    });
  }, [activeJob, jobs, options, queueRunning, targetLanguageReadiness]);

  const chooseFiles = useCallback(async () => {
    if (validationLockedRef.current) return;
    addPaths(await chooseVideoPaths());
  }, [addPaths]);

  const chooseOutputDirectory = useCallback(async () => {
    if (queueRunning || validationLockedRef.current) return;
    setChoosingOutputDirectory(true);
      try {
        const directory = await openOutputDirectoryPicker(
          options.outputDirectory ?? preferredYoutubeOutputDirectory,
        );
        if (!directory) return;
        setOptions((current) => ({
          ...current,
          outputLocationMode: "custom_directory",
          outputDirectory: directory,
        }));
        setPreferredYoutubeOutputDirectory(directory);
        try {
          await rememberOutputDirectory(directory);
          setOutputLocationError(null);
        } catch {
          setOutputLocationError(
            "Đã dùng thư mục này cho phiên hiện tại nhưng không thể ghi nhớ lựa chọn trong Application Support.",
          );
        }
      } finally {
        setChoosingOutputDirectory(false);
      }
    }, [options.outputDirectory, preferredYoutubeOutputDirectory, queueRunning]);

  const useSameOutputLocation = useCallback(() => {
    if (queueRunning || validationLockedRef.current) return;
    setOptions((current) => ({
      ...current,
      outputLocationMode: "same_as_input",
    }));
    setOutputLocationError(null);
  }, [queueRunning]);

  const useCustomOutputLocation = useCallback(() => {
    if (queueRunning || validationLockedRef.current) return;
    if (!options.outputDirectory) {
      void chooseOutputDirectory();
      return;
    }
    setOptions((current) => ({
      ...current,
      outputLocationMode: "custom_directory",
    }));
    setOutputLocationError(null);
  }, [chooseOutputDirectory, options.outputDirectory, queueRunning]);

  const startQueue = useCallback(async () => {
    if (queueRunning || validationLockedRef.current) return;
    if (!targetLanguageReadiness.ready) return;
    if (batchPolicy.hasYoutube && options.outputLocationMode !== "custom_directory") {
        setOutputLocationError("YouTube cần chọn thư mục lưu phụ đề trước khi bắt đầu.");
        return;
      }

    const outputReadiness = getOutputLocationReadiness(options);
    if (!outputReadiness.ready) {
      setOutputLocationError(outputReadiness.reason);
      return;
    }

    const queuedJobs = jobs.filter((job) => job.status === "queued");
    if (queuedJobs.length === 0) return;

    validationLockedRef.current = true;
    setOutputLocationError(null);
    setValidatingOutputLocation(true);
    let queueStarted = false;
    try {
        const result = await validateOutputLocations(
          queuedJobs.flatMap((job) =>
            job.source.kind === "local_file" ? [job.source.inputPath] : [],
          ),
        options.outputLocationMode,
        options.outputLocationMode === "custom_directory"
          ? options.outputDirectory
          : null,
      );
      const validationMessage = getOutputLocationValidationMessage(result);
      if (validationMessage) {
        setOutputLocationError(validationMessage);
        return;
      }

      setOutputLocationError(null);
      validatedBatchJobIdsRef.current = new Set(
        queuedJobs.map((job) => job.jobId),
      );
      setQueueRunning(true);
      queueStarted = true;
    } catch {
      setOutputLocationError(
        "Không thể kiểm tra nơi lưu phụ đề. Hãy thử lại hoặc chọn một thư mục khác.",
      );
    } finally {
      setValidatingOutputLocation(false);
      if (!queueStarted) validationLockedRef.current = false;
    }
  }, [batchPolicy.hasYoutube, jobs, options, queueRunning, targetLanguageReadiness]);

  const cancelCurrent = useCallback(async () => {
    if (!activeJob) return;
    await cancelJob(activeJob.jobId);
  }, [activeJob]);

  useEffect(() => {
    if (!validatingOutputLocation) {
      validationLockedRef.current = false;
    }
  }, [validatingOutputLocation]);

  return {
    jobs,
    activeJob,
    options,
      setOptions,
      queueRunning,
      hasYoutube: batchPolicy.hasYoutube,
      requiresGemini: batchPolicy.requiresGemini,
      targetLanguageReadiness,
    outputLocationReadiness: getOutputLocationReadiness(options),
    outputLocationError,
    outputLocationBusy: choosingOutputDirectory || validatingOutputLocation,
    choosingOutputDirectory,
    validatingOutputLocation,
      addPaths,
      addYoutubeUrl,
    chooseFiles,
    chooseOutputDirectory,
    useSameOutputLocation,
    useCustomOutputLocation,
    startQueue,
    cancelCurrent,
    removeJob: (jobId: string) => {
      if (!validationLockedRef.current) {
        dispatch({ type: "remove_job", jobId });
        setOutputLocationError(null);
      }
    },
    clearFinished: () => {
      if (!validationLockedRef.current) dispatch({ type: "clear_finished" });
    },
  };
}
