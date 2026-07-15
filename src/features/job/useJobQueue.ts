import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import {
  cancelJob,
  chooseVideoPaths,
  listenForFileDrops,
  listenJobEvents,
  startJob,
} from "../../lib/tauri";
import type { JobOptions, StartJobRequest } from "../../lib/types";
import { isJobActive, jobReducer } from "./jobReducer";

const defaultOptions: JobOptions = {
  model: "small",
  sourceLanguage: "auto",
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

    const request: StartJobRequest = {
      type: "start_job",
      jobId: nextJob.jobId,
      inputPath: nextJob.inputPath,
      outputLocationMode: "same_as_input",
      outputDirectory: null,
      model: options.model,
      sourceLanguage: options.sourceLanguage,
      targetLanguage: "none",
      task: "transcribe",
      translationProvider: "none",
      translationMode: "none",
      technicalTranslation: false,
      glossary: null,
      providerModel: null,
      device: options.device,
      outputFormats: options.includeVtt ? ["srt", "vtt"] : ["srt"],
      overwritePolicy: "suffix",
    };

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
    addPaths,
    chooseFiles,
    startQueue: () => setQueueRunning(true),
    cancelCurrent,
    removeJob: (jobId: string) => dispatch({ type: "remove_job", jobId }),
    clearFinished: () => dispatch({ type: "clear_finished" }),
  };
}
