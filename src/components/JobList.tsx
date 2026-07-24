import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { getAddedJobIds } from "../features/job/queueReveal";
import { getJobFailureRecovery } from "../features/job/jobFailurePresentation";
import type { QueuedJob } from "../lib/types";

const statusLabels: Record<QueuedJob["status"], string> = {
  queued: "Trong hàng đợi",
  preparing: "Chuẩn bị",
  loading_model: "Nạp model",
  extracting_audio: "Tách audio",
  transcribing: "Đang tạo phụ đề",
  translating: "Đang dịch",
  writing_output: "Đang ghi file",
  completed: "Hoàn tất",
  cancelling: "Đang hủy",
  cancelled: "Đã hủy",
  failed: "Thất bại",
};

interface JobListProps {
  jobs: QueuedJob[];
  autoRevealNewJobs: boolean;
  removalDisabled?: boolean;
  onRemove: (jobId: string) => void;
}

const nearBottomThreshold = 8;
const newJobHighlightDurationMs = 1_200;

function sameJobIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((jobId, index) => jobId === right[index])
  );
}

export function JobList({
  jobs,
  autoRevealNewJobs,
  removalDisabled = false,
  onRemove,
}: JobListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const previousJobIdsRef = useRef<ReadonlySet<string>>(new Set());
  const previousScrollHeightRef = useRef(0);
  const highlightTimeoutRef = useRef<number | null>(null);
  const [recentJobIds, setRecentJobIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [pendingRevealJobIds, setPendingRevealJobIds] = useState<string[]>([]);

  const markJobsAsRecent = useCallback((jobIds: string[]) => {
    if (!jobIds.length) return;

    setRecentJobIds(new Set(jobIds));
    if (highlightTimeoutRef.current !== null) {
      window.clearTimeout(highlightTimeoutRef.current);
    }
    highlightTimeoutRef.current = window.setTimeout(() => {
      setRecentJobIds(new Set());
      highlightTimeoutRef.current = null;
    }, newJobHighlightDurationMs);
  }, []);

  const revealJobs = useCallback(
    (jobIds: string[]) => {
      const list = listRef.current;
      const firstNewRow = rowRefs.current.get(jobIds[0]);
      if (!list || !firstNewRow) return;

      const listRect = list.getBoundingClientRect();
      const rowRect = firstNewRow.getBoundingClientRect();
      const targetTop = rowRect.top - listRect.top + list.scrollTop;
      const prefersReducedMotion =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      if (typeof list.scrollTo === "function") {
        list.scrollTo({
          top: targetTop,
          behavior: prefersReducedMotion ? "auto" : "smooth",
        });
      } else {
        list.scrollTop = targetTop;
      }
      markJobsAsRecent(jobIds);
    },
    [markJobsAsRecent],
  );

  useEffect(
    () => () => {
      if (highlightTimeoutRef.current !== null) {
        window.clearTimeout(highlightTimeoutRef.current);
      }
    },
    [],
  );

  useLayoutEffect(() => {
    const previousJobIds = previousJobIdsRef.current;
    const currentJobIds = new Set(jobs.map((job) => job.jobId));
    const addedJobIds = getAddedJobIds(previousJobIds, jobs);
    const hadExistingJobs = previousJobIds.size > 0;
    previousJobIdsRef.current = currentJobIds;

    const list = listRef.current;
    if (!list) {
      previousScrollHeightRef.current = 0;
      setPendingRevealJobIds((currentPendingJobIds) =>
        currentPendingJobIds.length > 0 ? [] : currentPendingJobIds,
      );
      return;
    }

    const previousScrollHeight = previousScrollHeightRef.current;
    const wasNearBottom =
      previousScrollHeight === 0 ||
      list.scrollTop + list.clientHeight >=
        previousScrollHeight - nearBottomThreshold;

    previousScrollHeightRef.current = list.scrollHeight;
    setPendingRevealJobIds((currentPendingJobIds) => {
      const availablePendingJobIds = currentPendingJobIds.filter((jobId) =>
        currentJobIds.has(jobId),
      );
      return sameJobIds(availablePendingJobIds, currentPendingJobIds)
        ? currentPendingJobIds
        : availablePendingJobIds;
    });

    if (!hadExistingJobs || addedJobIds.length === 0) return;

    if (autoRevealNewJobs && wasNearBottom) {
      revealJobs(addedJobIds);
      return;
    }

    setPendingRevealJobIds((currentPendingJobIds) => [
      ...currentPendingJobIds,
      ...addedJobIds.filter(
        (jobId) => !currentPendingJobIds.includes(jobId),
      ),
    ]);
  }, [autoRevealNewJobs, jobs, revealJobs]);

  if (!jobs.length) {
    return (
        <div className="empty-state">
          <p>File đã chọn sẽ xuất hiện tại đây.</p>
          <span>SRT bắt buộc · hỗ trợ video và audio phổ biến</span>
        </div>
    );
  }

  const handleListScroll = () => {
    if (!pendingRevealJobIds.length) return;

    const list = listRef.current;
    const firstPendingRow = rowRefs.current.get(pendingRevealJobIds[0]);
    if (!list || !firstPendingRow) return;

    const listRect = list.getBoundingClientRect();
    const rowRect = firstPendingRow.getBoundingClientRect();
    const pendingRowIsVisible =
      rowRect.top < listRect.bottom && rowRect.bottom > listRect.top;
    if (!pendingRowIsVisible) return;

    markJobsAsRecent(pendingRevealJobIds);
    setPendingRevealJobIds([]);
  };

  const handleRevealPendingJobs = () => {
    revealJobs(pendingRevealJobIds);
    setPendingRevealJobIds([]);
  };

  return (
    <div className="job-list-shell">
      <div
        ref={listRef}
        className="job-list"
        aria-label="Hàng đợi xử lý"
        aria-live="polite"
        onScroll={handleListScroll}
      >
        {jobs.map((job, index) => (
          <article
            ref={(element) => {
              if (element) {
                rowRefs.current.set(job.jobId, element);
              } else {
                rowRefs.current.delete(job.jobId);
              }
            }}
            className={`job-row${recentJobIds.has(job.jobId) ? " is-new-job" : ""}`}
            key={job.jobId}
          >
            <div className="job-index">
              {String(index + 1).padStart(2, "0")}
            </div>
            <div className="job-copy">
              <strong title={job.inputPath}>{job.fileName}</strong>
              <span className={`status status-${job.status}`}>
                {statusLabels[job.status]}
              </span>
                {job.error && (
                  <small className="job-error">
                    {job.error} {getJobFailureRecovery(job.errorCode)}
                  </small>
                )}
            </div>
            <div
              className="job-progress"
              role="progressbar"
              aria-label={`Tiến trình ${job.fileName}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(job.progress)}
            >
              <span style={{ transform: `scaleX(${job.progress / 100})` }} />
            </div>
            <strong className="progress-number">
              {Math.round(job.progress)}%
            </strong>
            <button
              type="button"
              className="remove-button"
              onClick={() => onRemove(job.jobId)}
                disabled={
                  removalDisabled ||
                  !["queued", "completed", "cancelled", "failed"].includes(
                    job.status,
                  )
              }
              aria-label={`Xóa ${job.fileName}`}
            >
              Xóa
            </button>
          </article>
        ))}
      </div>
      {pendingRevealJobIds.length > 0 && (
        <div className="new-jobs-notice" role="status" aria-live="polite">
          <button
            type="button"
            className="new-jobs-button"
            onClick={handleRevealPendingJobs}
            aria-label={`Hiển thị ${pendingRevealJobIds.length} file mới ở cuối hàng đợi`}
          >
            {pendingRevealJobIds.length} file mới ở cuối
            <span aria-hidden="true">↓</span>
          </button>
        </div>
      )}
    </div>
  );
}
