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
  onRemove: (jobId: string) => void;
}

export function JobList({ jobs, onRemove }: JobListProps) {
  if (!jobs.length) {
    return (
      <div className="empty-state">
        <p>File đã chọn sẽ xuất hiện tại đây.</p>
        <span>SRT được lưu cạnh file gốc · hỗ trợ video và audio phổ biến</span>
      </div>
    );
  }

  return (
    <div className="job-list" aria-label="Hàng đợi xử lý" aria-live="polite">
      {jobs.map((job, index) => (
        <article className="job-row" key={job.jobId}>
          <div className="job-index">{String(index + 1).padStart(2, "0")}</div>
          <div className="job-copy">
            <strong title={job.inputPath}>{job.fileName}</strong>
            <span className={`status status-${job.status}`}>
              {statusLabels[job.status]}
            </span>
            {job.error && (
              <small className="job-error">
                {job.error} Gỡ file rồi thêm lại để thử lại.
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
          <strong className="progress-number">{Math.round(job.progress)}%</strong>
          <button
            type="button"
            className="remove-button"
            onClick={() => onRemove(job.jobId)}
              disabled={!['queued', 'completed', 'cancelled', 'failed'].includes(job.status)}
              aria-label={`Xóa ${job.fileName}`}
            >
              Xóa
            </button>
        </article>
      ))}
    </div>
  );
}
