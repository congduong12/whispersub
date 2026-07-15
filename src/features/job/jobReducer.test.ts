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
});

describe("fileNameFromPath", () => {
  it("supports POSIX and Windows-style separators", () => {
    expect(fileNameFromPath("/tmp/video.mp4")).toBe("video.mp4");
    expect(fileNameFromPath("C:\\media\\video.mp4")).toBe("video.mp4");
  });
});
