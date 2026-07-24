import { describe, expect, it } from "vitest";
import { fileNameFromPath, jobReducer } from "./jobReducer";

describe("jobReducer", () => {
  it("adds unique paths and keeps queue order", () => {
    const jobs = jobReducer([], {
      type: "add_paths",
      paths: ["/video/lesson.mp4", "/video/lesson.mp4", "/video/demo.mov"],
    });

    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.fileName)).toEqual([
      "lesson.mp4",
      "demo.mov",
    ]);
  });

  it("appends a new batch after terminal history without changing FIFO order", () => {
    let jobs = jobReducer([], {
      type: "add_paths",
      paths: ["/video/lesson-1.mp4", "/video/lesson-2.mp4"],
    });
    jobs = jobReducer(jobs, {
      type: "event_received",
      event: {
        type: "completed",
        jobId: jobs[0].jobId,
        outputs: ["/video/lesson-1.srt"],
      },
    });
    jobs = jobReducer(jobs, {
      type: "add_paths",
      paths: ["/video/lesson-3.mp4"],
    });

    expect(jobs.map((job) => job.fileName)).toEqual([
      "lesson-1.mp4",
      "lesson-2.mp4",
      "lesson-3.mp4",
    ]);
    expect(jobs[2].status).toBe("queued");
  });

  it("moves a job through progress and completion events", () => {
    const [queued] = jobReducer([], {
      type: "add_paths",
      paths: ["/video/lesson.mp4"],
    });
    const progressing = jobReducer([queued], {
      type: "event_received",
      event: {
        type: "progress",
        jobId: queued.jobId,
        phase: "transcribing",
        percent: 42,
      },
    });
    const completed = jobReducer(progressing, {
      type: "event_received",
      event: {
        type: "completed",
        jobId: queued.jobId,
        outputs: ["/video/lesson.srt"],
      },
    });

    expect(progressing[0]).toMatchObject({
      status: "transcribing",
      progress: 42,
    });
    expect(completed[0]).toMatchObject({
      status: "completed",
      progress: 100,
      outputs: ["/video/lesson.srt"],
    });
  });

  it("clears only terminal history and preserves queued or active jobs", () => {
    let jobs = jobReducer([], {
      type: "add_paths",
      paths: [
        "/video/completed.mp4",
        "/video/failed.mp4",
        "/video/cancelled.mp4",
        "/video/active.mp4",
        "/video/queued.mp4",
      ],
    });

    jobs = jobReducer(jobs, {
      type: "event_received",
      event: {
        type: "completed",
        jobId: jobs[0].jobId,
        outputs: ["/video/completed.srt"],
      },
    });
    jobs = jobReducer(jobs, {
      type: "event_received",
      event: {
        type: "error",
        jobId: jobs[1].jobId,
        code: "TRANSLATION_FAILED",
        message: "Translation failed",
        retryable: false,
      },
    });
    jobs = jobReducer(jobs, {
      type: "event_received",
      event: { type: "cancelled", jobId: jobs[2].jobId },
    });
    jobs = jobReducer(jobs, {
      type: "mark_started",
      jobId: jobs[3].jobId,
    });

    const remainingJobs = jobReducer(jobs, { type: "clear_finished" });

    expect(remainingJobs.map((job) => job.fileName)).toEqual([
      "active.mp4",
      "queued.mp4",
    ]);
      expect(remainingJobs.map((job) => job.status)).toEqual([
      "preparing",
      "queued",
      ]);
      expect(jobs[1].errorCode).toBe("TRANSLATION_FAILED");
  });
});

describe("fileNameFromPath", () => {
  it("supports POSIX and Windows-style separators", () => {
    expect(fileNameFromPath("/tmp/video.mp4")).toBe("video.mp4");
    expect(fileNameFromPath("C:\\media\\video.mp4")).toBe("video.mp4");
  });
});
