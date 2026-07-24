import { describe, expect, it } from "vitest";
import {
  getConnectionResultMessage,
  getEndpointSummary,
  PROVIDER_ACCOUNT_GUIDES,
} from "./providerAccountGuidance";

describe("provider account guidance", () => {
  it("keeps three provider-specific steps and trusted official links", () => {
    expect(PROVIDER_ACCOUNT_GUIDES.gemini).toMatchObject({
      summary: "Cách lấy Gemini API key",
      url: "https://aistudio.google.com/apikey",
    });
      expect(PROVIDER_ACCOUNT_GUIDES.openai).toMatchObject({
        summary: "Cách lấy OpenAI API key",
        url: "https://platform.openai.com/api-keys",
        readiness: {
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
      });
    expect(PROVIDER_ACCOUNT_GUIDES.gemini.steps).toHaveLength(3);
    expect(PROVIDER_ACCOUNT_GUIDES.openai.steps).toHaveLength(3);
  });

  it("distinguishes official and custom endpoints without exposing paths", () => {
    expect(
      getEndpointSummary("gemini", "https://generativelanguage.googleapis.com/"),
    ).toBe("Endpoint chính thức · generativelanguage.googleapis.com");
    expect(getEndpointSummary("openai", "https://gateway.example.com/v1"))
      .toBe("Endpoint tùy chỉnh · gateway.example.com");
    expect(getEndpointSummary("openai", "not-a-url"))
      .toBe("Endpoint tùy chỉnh");
    });

    it("clarifies that an OpenAI Models probe does not prove billing readiness", () => {
      expect(
        getConnectionResultMessage("openai", {
          outcome: "connected",
          message: "Provider accepted the API key.",
        }),
      ).toBe(
        "API key dùng được với Models API. Kiểm tra này chưa xác nhận billing, credit hoặc khả năng tạo bản dịch.",
      );
      expect(
        getConnectionResultMessage("gemini", {
          outcome: "connected",
          message: "Gemini connected.",
        }),
      ).toBe("Gemini connected.");
    });
  });
