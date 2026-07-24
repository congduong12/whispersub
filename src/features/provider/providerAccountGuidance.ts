import { DEFAULT_PROVIDER_BASE_URLS } from "../../lib/providerAccounts";
import type {
  Provider,
  ProviderConnectionTestResult,
} from "../../lib/types";

interface ProviderGuideLink {
  label: string;
  url: string;
}

interface ProviderReadinessGuide {
  title: string;
  detail: string;
  links: readonly ProviderGuideLink[];
}

export interface ProviderAccountGuide {
  summary: string;
  steps: readonly string[];
  linkLabel: string;
  url: string;
  readiness?: ProviderReadinessGuide;
}

export const PROVIDER_ACCOUNT_GUIDES: Record<Provider, ProviderAccountGuide> = {
  gemini: {
    summary: "Cách lấy Gemini API key",
    steps: [
      "Mở Google AI Studio và vào trang API keys.",
      "Chọn hoặc import project, sau đó tạo API key.",
      "Sao chép key, dán vào đây và kiểm tra kết nối nếu muốn.",
    ],
    linkLabel: "Mở Google AI Studio",
    url: "https://aistudio.google.com/apikey",
  },
  openai: {
    summary: "Cách lấy OpenAI API key",
    steps: [
      "Mở OpenAI Platform và chọn đúng project.",
      "Vào API keys và chọn Create new secret key.",
      "Sao chép key, dán vào đây và kiểm tra kết nối nếu muốn.",
    ],
      linkLabel: "Mở OpenAI API Keys",
      url: "https://platform.openai.com/api-keys",
      readiness: {
        title: "API key hợp lệ chưa đồng nghĩa có thể dịch",
        detail:
          "Models API có thể hoạt động khi billing chưa bật hoặc credit đã hết. WhisperSub sẽ kiểm tra model và Responses API bằng nội dung giả lập sau khi bạn xác nhận dịch, trước khi chạy Whisper.",
        links: [
          {
            label: "Mở Billing",
            url: "https://platform.openai.com/settings/organization/billing/overview",
          },
          {
            label: "Xem Limits",
            url: "https://platform.openai.com/settings/organization/limits",
          },
        ],
      },
  },
};

export function getConnectionResultMessage(
  provider: Provider,
  result: ProviderConnectionTestResult,
): string {
  if (provider === "openai" && result.outcome === "connected") {
    return "API key dùng được với Models API. Kiểm tra này chưa xác nhận billing, credit hoặc khả năng tạo bản dịch.";
  }
  return result.message;
}

export function getEndpointSummary(provider: Provider, baseUrl: string): string {
  const fallbackUrl = DEFAULT_PROVIDER_BASE_URLS[provider];
  const candidate = baseUrl.trim() || fallbackUrl;
  try {
    const parsed = new URL(candidate);
    const isOfficial = candidate.replace(/\/+$/, "") === fallbackUrl;
    return `${isOfficial ? "Endpoint chính thức" : "Endpoint tùy chỉnh"} · ${parsed.host}`;
  } catch {
    return "Endpoint tùy chỉnh";
  }
}
