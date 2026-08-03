import { describe, expect, it } from "vitest";
import type { JobStatus, QueuedJob } from "../../lib/types";
import { getQueueTerminalSummary } from "./queueSummary";

function makeJob(status: JobStatus, index = 1): QueuedJob {
  return {
    jobId: `job-${index}`,
    source: { kind: "local_file", inputPath: `/video/lesson-${index}.mp4` },
    fileName: `lesson-${index}.mp4`,
    status,
    progress: status === "completed" ? 100 : 0,
    segments: [],
    outputs: status === "completed" ? [`/video/lesson-${index}.srt`] : [],
    error: status === "failed" ? "Translation failed" : null,
    errorCode: status === "failed" ? "TRANSLATION_FAILED" : null,
  };
}

describe("getQueueTerminalSummary", () => {
  it("does not treat an empty queue as a completed batch", () => {
      expect(getQueueTerminalSummary([])).toEqual({
        terminalCount: 0,
        queuedCount: 0,
        activeCount: 0,
        allTerminal: false,
      countLabel: null,
      helperText: null,
    });
  });

    it("separates queued work from terminal history in a mixed queue", () => {
      const summary = getQueueTerminalSummary([
      makeJob("completed", 1),
      makeJob("queued", 2),
    ]);

      expect(summary).toEqual({
        terminalCount: 1,
        queuedCount: 1,
        activeCount: 0,
        allTerminal: false,
        countLabel: "1 file chờ xử lý · 1 mục lịch sử",
        helperText: null,
      });
    });

    it("reports active, queued, and history counts without merging their meaning", () => {
      const summary = getQueueTerminalSummary([
        makeJob("completed", 1),
        makeJob("transcribing", 2),
        makeJob("queued", 3),
      ]);

      expect(summary).toMatchObject({
        terminalCount: 1,
        queuedCount: 1,
        activeCount: 1,
        allTerminal: false,
        countLabel:
          "1 file đang xử lý · 1 file chờ xử lý · 1 mục lịch sử",
      });
    });

    it("describes an all-completed batch without assuming an output location", () => {
    const summary = getQueueTerminalSummary([
      makeJob("completed", 1),
      makeJob("completed", 2),
    ]);

    expect(summary).toMatchObject({
      terminalCount: 2,
      allTerminal: true,
      countLabel: "2 file đã hoàn tất",
        helperText:
          "Phụ đề đã được lưu thành công · Xóa lịch sử không xóa file SRT/VTT.",
    });
  });

  it("reports mixed terminal outcomes without claiming every file completed", () => {
    const summary = getQueueTerminalSummary([
      makeJob("completed", 1),
      makeJob("failed", 2),
      makeJob("cancelled", 3),
    ]);

    expect(summary).toMatchObject({
      terminalCount: 3,
      allTerminal: true,
      countLabel: "3 file đã xử lý",
      helperText:
        "1 hoàn tất · 1 thất bại · 1 đã hủy · Xóa lịch sử không xóa file SRT/VTT đã tạo.",
    });
  });
});
