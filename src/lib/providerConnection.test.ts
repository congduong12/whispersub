import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testProviderConnection } from "./tauri";

describe("provider connection browser adapter", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void) => globalThis.setTimeout(callback, 0),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("presents a successful provider probe", async () => {
    await expect(
      testProviderConnection(
        "gemini",
        "test-key-gemini",
        "https://generativelanguage.googleapis.com",
      ),
    ).resolves.toEqual({
      outcome: "connected",
      message: "Kết nối thành công. Provider đã chấp nhận API key.",
    });
  });

  it("keeps invalid credentials as an actionable error", async () => {
    await expect(
      testProviderConnection("openai", "invalid-test-key", "https://api.openai.com/v1"),
    ).rejects.toThrow(/không hợp lệ/);
  });

  it("treats a provider rate limit as an inconclusive warning", async () => {
    await expect(
      testProviderConnection("gemini", "test-key-gemini", "https://rate-limit.example"),
    ).resolves.toMatchObject({ outcome: "rate_limited" });
  });
});
