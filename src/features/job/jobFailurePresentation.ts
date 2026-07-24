const OPENAI_BILLING_RECOVERY =
  "Mở API Keys → OpenAI để kiểm tra Billing/Limits, sau đó thêm lại file.";

export function getJobFailureRecovery(errorCode: string | null): string {
  if (
    errorCode === "OPENAI_BILLING_NOT_READY" ||
    errorCode === "TRANSLATION_QUOTA_EXCEEDED"
  ) {
    return OPENAI_BILLING_RECOVERY;
  }
  return "Gỡ file rồi thêm lại để thử lại.";
}
