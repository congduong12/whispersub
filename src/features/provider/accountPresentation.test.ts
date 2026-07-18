import { describe, expect, it } from "vitest";
import {
  getProviderStatus,
  normalizeAccountError,
} from "./accountPresentation";

describe("provider account presentation", () => {
  it("presents both provider accounts as translation-ready", () => {
    expect(getProviderStatus("openai", null, 0)).toEqual({
      title: "OpenAI · Chưa có tài khoản",
      detail: "Thêm OpenAI account để dùng cho dịch transcript.",
    });
      expect(getProviderStatus("gemini", "gemini_ca_nhan_1.json", 1)).toEqual({
        title: "Gemini · Đã chọn tài khoản",
        detail: "Account sẵn sàng để chọn trên Dashboard; mỗi batch vẫn cần consent.",
      });
  });

  it("distinguishes saved accounts from an active account selection", () => {
    expect(getProviderStatus("openai", null, 2)).toEqual({
      title: "OpenAI · Chưa chọn tài khoản",
      detail: "Chọn một OpenAI account để dùng trên Dashboard.",
    });
  });

  it("removes internal error categories without exposing payloads", () => {
    expect(
      normalizeAccountError("validation: Hãy nhập tên hiển thị cho account."),
    ).toBe("Hãy nhập tên hiển thị cho account.");
    expect(normalizeAccountError(new Error("storage: Không thể ghi file."))).toBe(
      "Không thể ghi file.",
    );
    expect(
      normalizeAccountError("connection: API key không hợp lệ hoặc đã bị thu hồi."),
    ).toBe("API key không hợp lệ hoặc đã bị thu hồi.");
  });
});
