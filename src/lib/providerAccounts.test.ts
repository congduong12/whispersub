import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_BASE_URLS,
  normalizeProviderBaseUrl,
} from "./providerAccounts";

describe("provider base URL", () => {
  it("uses the official provider endpoint when the input is blank", () => {
    expect(normalizeProviderBaseUrl("openai", " ")).toBe(
      DEFAULT_PROVIDER_BASE_URLS.openai,
    );
    expect(normalizeProviderBaseUrl("gemini", "")).toBe(
      DEFAULT_PROVIDER_BASE_URLS.gemini,
    );
  });

  it("normalizes HTTPS and permits loopback HTTP", () => {
    expect(normalizeProviderBaseUrl("openai", " https://gateway.example/v1/// ")).toBe(
      "https://gateway.example/v1",
    );
    expect(normalizeProviderBaseUrl("gemini", "http://localhost:8787/")).toBe(
      "http://localhost:8787",
    );
  });

  it("rejects unsafe or ambiguous endpoints", () => {
    expect(() => normalizeProviderBaseUrl("openai", "http://gateway.example/v1")).toThrow(
      /HTTPS/,
    );
    expect(() => normalizeProviderBaseUrl("openai", "https://user@example.com/v1")).toThrow(
      /đăng nhập/,
    );
    expect(() => normalizeProviderBaseUrl("gemini", "https://example.com/root?q=1")).toThrow(
      /query|fragment/,
    );
  });
});
