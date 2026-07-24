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
});
