import type { Provider } from "../../lib/types";

export interface ProviderStatus {
  title: string;
  detail: string;
}

export function getProviderStatus(
  provider: Provider,
  activeAccountFile: string | null,
  accountCount: number,
): ProviderStatus {
  const providerName = provider === "openai" ? "OpenAI" : "Gemini";
  if (accountCount === 0) {
    return {
      title: `${providerName} · Chưa có tài khoản`,
      detail: `Thêm ${providerName} account để dùng cho dịch transcript.`,
    };
  }
  if (!activeAccountFile) {
    return {
      title: `${providerName} · Chưa chọn tài khoản`,
      detail: `Chọn một ${providerName} account để dùng trên Dashboard.`,
    };
  }
  return {
    title: `${providerName} · Đã chọn tài khoản`,
    detail: "Account sẵn sàng để chọn trên Dashboard; mỗi batch vẫn cần consent.",
  };
}

export function normalizeAccountError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^(validation|storage|not_found|connection):\s*/i, "");
}
