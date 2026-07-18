import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import {
  cancelJob,
  chooseVideoPaths,
  listenForFileDrops,
  listenJobEvents,
  startJob,
} from "../../lib/tauri";
import type { JobOptions } from "../../lib/types";
import { isJobActive, jobReducer } from "./jobReducer";
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
};

export function useJobQueue() {
  const [jobs, dispatch] = useReducer(jobReducer, []);
  const [options, setOptions] = useState<JobOptions>(defaultOptions);
  const [queueRunning, setQueueRunning] = useState(false);

  const addPaths = useCallback((paths: string[]) => {
    dispatch({ type: "add_paths", paths });
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
    const nextJob = jobs.find((job) => job.status === "queued");
    if (!nextJob) {
      setQueueRunning(false);
      return;
    }
      if (!isTargetLanguageReady(options)) {
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
    addPaths(await chooseVideoPaths());
  }, [addPaths]);

  const cancelCurrent = useCallback(async () => {
    if (!activeJob) return;
    await cancelJob(activeJob.jobId);
  }, [activeJob]);

  return {
    jobs,
    activeJob,
    options,
    setOptions,
    queueRunning,
      targetLanguageReadiness: getTargetLanguageReadiness(options),
    addPaths,
    chooseFiles,
    startQueue: () => {
      if (isTargetLanguageReady(options)) setQueueRunning(true);
    },
    cancelCurrent,
    removeJob: (jobId: string) => dispatch({ type: "remove_job", jobId }),
    clearFinished: () => dispatch({ type: "clear_finished" }),
  };
}
