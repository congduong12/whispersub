const OPENAI_BILLING_RECOVERY =
  "Mở API Keys → OpenAI để kiểm tra Billing/Limits, sau đó thêm lại file.";

export function getJobFailureRecovery(errorCode: string | null): string {
  if (
    errorCode === "OPENAI_BILLING_NOT_READY" ||
    errorCode === "TRANSLATION_QUOTA_EXCEEDED"
  ) {
    return OPENAI_BILLING_RECOVERY;
  }
  if (errorCode === "YOUTUBE_DURATION_EXCEEDED") {
    return "Video dài quá 4 giờ; hãy chọn video ngắn hơn.";
  }
  if (errorCode === "YOUTUBE_DISK_INSUFFICIENT") {
    return "Giải phóng dung lượng ổ đĩa rồi thử lại.";
  }
  if (errorCode === "YOUTUBE_DURATION_UNKNOWN") {
    return "Không xác định được độ dài video nên không thể tải audio fallback.";
  }
  if (errorCode === "YTDLP_JS_RUNTIME_NOT_READY") {
    return "Cài Deno trên máy rồi thử lại video này.";
  }
  if (errorCode === "YOUTUBE_LIVE_UNSUPPORTED") {
    return "Chỉ hỗ trợ video đã phát xong, không hỗ trợ livestream.";
  }
  return "Gỡ file rồi thêm lại để thử lại.";
}
