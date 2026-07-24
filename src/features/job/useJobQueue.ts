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
  listenForFileDrops,
  listenJobEvents,
  startJob,
  validateOutputLocations,
} from "../../lib/tauri";
import type { JobOptions } from "../../lib/types";
import { isJobActive, jobReducer } from "./jobReducer";
import {
  getOutputLocationReadiness,
  getOutputLocationValidationMessage,
} from "./outputLocation";
import { findNextValidatedQueuedJob } from "./queueBatch";
import { buildLocalStartJobRequest } from "./startJobRequest";
import { getTargetLanguageReadiness, isTargetLanguageReady } from "./targetLanguage";

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
  const validationLockedRef = useRef(false);
  const validatedBatchJobIdsRef = useRef<Set<string>>(new Set());

  const addPaths = useCallback((paths: string[]) => {
    if (validationLockedRef.current) return;
    dispatch({ type: "add_paths", paths });
    if (paths.length > 0) setOutputLocationError(null);
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
    if (!isTargetLanguageReady(options)) {
      validatedBatchJobIdsRef.current.clear();
      setQueueRunning(false);
      return;
    }

    const request = buildLocalStartJobRequest(nextJob, options);

    dispatch({ type: "mark_started", jobId: nextJob.jobId });
    void startJob(request).catch((error: unknown) => {
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
  }, [activeJob, jobs, options, queueRunning]);

  const chooseFiles = useCallback(async () => {
    if (validationLockedRef.current) return;
    addPaths(await chooseVideoPaths());
  }, [addPaths]);

  const chooseOutputDirectory = useCallback(async () => {
    if (queueRunning || validationLockedRef.current) return;
    setChoosingOutputDirectory(true);
    try {
      const directory = await openOutputDirectoryPicker();
      if (!directory) return;
      setOptions((current) => ({
        ...current,
        outputLocationMode: "custom_directory",
        outputDirectory: directory,
      }));
      setOutputLocationError(null);
    } finally {
      setChoosingOutputDirectory(false);
    }
  }, [queueRunning]);

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
    if (!isTargetLanguageReady(options)) return;

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
        queuedJobs.map((job) => job.inputPath),
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
  }, [jobs, options, queueRunning]);

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
    targetLanguageReadiness: getTargetLanguageReadiness(options),
    outputLocationReadiness: getOutputLocationReadiness(options),
    outputLocationError,
    outputLocationBusy: choosingOutputDirectory || validatingOutputLocation,
    choosingOutputDirectory,
    validatingOutputLocation,
    addPaths,
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
