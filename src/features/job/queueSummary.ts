import type { QueuedJob } from "../../lib/types";
import { isJobActive, isJobTerminal } from "./jobReducer";

export interface QueueTerminalSummary {
  terminalCount: number;
  queuedCount: number;
  activeCount: number;
  allTerminal: boolean;
  countLabel: string | null;
  helperText: string | null;
}

export function getQueueTerminalSummary(
  jobs: QueuedJob[],
): QueueTerminalSummary {
  const terminalJobs = jobs.filter(isJobTerminal);
  const terminalCount = terminalJobs.length;
  const queuedCount = jobs.filter((job) => job.status === "queued").length;
  const activeCount = jobs.filter(isJobActive).length;
  const allTerminal = jobs.length > 0 && terminalCount === jobs.length;

  if (!allTerminal) {
    const currentBatchParts = [
      activeCount > 0 ? `${activeCount} file đang xử lý` : null,
      queuedCount > 0 ? `${queuedCount} file chờ xử lý` : null,
      terminalCount > 0 ? `${terminalCount} mục lịch sử` : null,
    ].filter((part): part is string => part !== null);

    return {
      terminalCount,
      queuedCount,
      activeCount,
      allTerminal: false,
      countLabel:
        terminalCount > 0 && currentBatchParts.length > 0
          ? currentBatchParts.join(" · ")
          : null,
      helperText: null,
    };
  }

  const completedCount = terminalJobs.filter(
    (job) => job.status === "completed",
  ).length;
  const failedCount = terminalJobs.filter(
    (job) => job.status === "failed",
  ).length;
  const cancelledCount = terminalJobs.filter(
    (job) => job.status === "cancelled",
  ).length;

  if (completedCount === jobs.length) {
      return {
        terminalCount,
        queuedCount,
        activeCount,
        allTerminal: true,
      countLabel: `${jobs.length} file đã hoàn tất`,
      helperText:
        "Phụ đề đã được lưu thành công · Xóa lịch sử không xóa file SRT/VTT.",
    };
  }

  const outcomeParts = [
    completedCount > 0 ? `${completedCount} hoàn tất` : null,
    failedCount > 0 ? `${failedCount} thất bại` : null,
    cancelledCount > 0 ? `${cancelledCount} đã hủy` : null,
  ].filter((part): part is string => part !== null);

  return {
    terminalCount,
    queuedCount,
    activeCount,
    allTerminal: true,
    countLabel: `${jobs.length} file đã xử lý`,
    helperText: `${outcomeParts.join(" · ")} · Xóa lịch sử không xóa file SRT/VTT đã tạo.`,
  };
}
