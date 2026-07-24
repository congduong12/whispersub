import type {
  JobOptions,
  OutputLocationValidationResult,
} from "../../lib/types";

export interface OutputLocationReadiness {
  ready: boolean;
  reason: string;
}

export function getOutputLocationReadiness(
  options: Pick<JobOptions, "outputLocationMode" | "outputDirectory">,
): OutputLocationReadiness {
  if (
    options.outputLocationMode === "custom_directory" &&
    !options.outputDirectory?.trim()
  ) {
    return {
      ready: false,
      reason: "Chọn thư mục lưu cho batch trước khi bắt đầu.",
    };
  }

  return {
    ready: true,
    reason:
      options.outputLocationMode === "same_as_input"
        ? "Phụ đề sẽ được lưu cạnh từng file gốc."
        : "Phụ đề sẽ được lưu vào thư mục đã chọn.",
  };
}

export function getOutputLocationValidationMessage(
  result: OutputLocationValidationResult,
): string | null {
  if (result.valid) return null;

  switch (result.code) {
    case "DIRECTORY_REQUIRED":
      return "Chọn thư mục lưu cho batch trước khi bắt đầu.";
    case "DIRECTORY_NOT_ABSOLUTE":
      return "Thư mục lưu phải là một đường dẫn tuyệt đối.";
    case "INPUT_NOT_FOUND":
      return "Một file nguồn không còn tồn tại. Hãy xóa file đó khỏi hàng đợi và chọn lại.";
    case "DIRECTORY_NOT_FOUND":
      return "Thư mục lưu không còn tồn tại. Hãy chọn một thư mục khác.";
    case "DIRECTORY_NOT_WRITABLE":
      return "Không thể ghi vào thư mục này. Hãy chọn thư mục khác hoặc kiểm tra quyền truy cập.";
    case "NO_INPUTS":
      return "Chọn ít nhất một file trước khi bắt đầu.";
    case "INVALID_MODE":
    default:
      return "Không thể xác nhận nơi lưu phụ đề. Hãy kiểm tra lựa chọn và thử lại.";
  }
}

export function getOutputDirectoryName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const name = normalized.split(/[\\/]/).pop();
  return name || path;
}
