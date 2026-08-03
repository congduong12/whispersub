import { describe, expect, it } from "vitest";
import { getJobFailureRecovery } from "./jobFailurePresentation";

describe("job failure presentation", () => {
  it("gives preflight billing failure an actionable, accurate recovery", () => {
    expect(getJobFailureRecovery("OPENAI_BILLING_NOT_READY")).toBe(
      "Mở API Keys → OpenAI để kiểm tra Billing/Limits, sau đó thêm lại file.",
    );
  });

  it("distinguishes quota exhausted during translation", () => {
    expect(getJobFailureRecovery("TRANSLATION_QUOTA_EXCEEDED")).toBe(
      "Mở API Keys → OpenAI để kiểm tra Billing/Limits, sau đó thêm lại file.",
    );
  });

  it("keeps the existing generic recovery for unrelated failures", () => {
    expect(getJobFailureRecovery("FFMPEG_FAILED")).toBe(
      "Gỡ file rồi thêm lại để thử lại.",
    );
  });

  it("explains YouTube guard and local runtime recovery", () => {
    expect(getJobFailureRecovery("YOUTUBE_DURATION_EXCEEDED")).toContain("4 giờ");
    expect(getJobFailureRecovery("YOUTUBE_DISK_INSUFFICIENT")).toContain("dung lượng");
    expect(getJobFailureRecovery("YTDLP_JS_RUNTIME_NOT_READY")).toContain("Deno");
  });
});
