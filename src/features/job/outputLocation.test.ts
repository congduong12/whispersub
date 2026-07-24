import { describe, expect, it } from "vitest";
import {
  getOutputDirectoryName,
  getOutputLocationReadiness,
  getOutputLocationValidationMessage,
} from "./outputLocation";

describe("output location", () => {
  it("keeps same-as-input ready without a directory", () => {
    expect(
      getOutputLocationReadiness({
        outputLocationMode: "same_as_input",
        outputDirectory: null,
      }),
    ).toMatchObject({ ready: true });
  });

  it("requires a directory for custom mode", () => {
    expect(
      getOutputLocationReadiness({
        outputLocationMode: "custom_directory",
        outputDirectory: null,
      }),
    ).toEqual({
      ready: false,
      reason: "Chọn thư mục lưu cho batch trước khi bắt đầu.",
    });
  });

  it("maps a non-writable directory to actionable Vietnamese copy", () => {
    expect(
      getOutputLocationValidationMessage({
        valid: false,
        code: "DIRECTORY_NOT_WRITABLE",
        path: "/Volumes/Read only",
      }),
    ).toBe(
      "Không thể ghi vào thư mục này. Hãy chọn thư mục khác hoặc kiểm tra quyền truy cập.",
    );
  });

  it("extracts a compact folder name from macOS and Windows-like paths", () => {
    expect(getOutputDirectoryName("/Users/mac/Movies/Subtitles/")).toBe("Subtitles");
    expect(getOutputDirectoryName("C:\\Media\\Subtitles")).toBe("Subtitles");
  });
});
