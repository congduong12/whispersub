import type { Dispatch, SetStateAction } from "react";
import type { JobOptions } from "../../lib/types";

interface OutputSettingsProps {
  options: JobOptions;
  setOptions: Dispatch<SetStateAction<JobOptions>>;
  queuedCount: number;
  disabled: boolean;
  choosingDirectory: boolean;
  error: string | null;
  onChooseDirectory: () => void;
  onUseSameDirectory: () => void;
  onUseCustomDirectory: () => void;
}

export function OutputSettings({
  options,
  setOptions,
  queuedCount,
  disabled,
  choosingDirectory,
  error,
  onChooseDirectory,
  onUseSameDirectory,
  onUseCustomDirectory,
}: OutputSettingsProps) {
  const usingCustomDirectory =
    options.outputLocationMode === "custom_directory";
  const batchCopy =
    queuedCount > 0
      ? `Tất cả ${queuedCount} file đang chờ sẽ được lưu vào thư mục này.`
      : "Mọi file trong batch tiếp theo sẽ được lưu vào thư mục này.";

  return (
    <section className="output-settings" aria-labelledby="output-settings-title">
      <div className="output-settings-heading">
        <strong id="output-settings-title">Xuất phụ đề</strong>
        <small>Chọn nơi nhận kết quả trước khi bắt đầu queue.</small>
      </div>

      <fieldset className="output-location-group" disabled={disabled}>
        <legend>Nơi lưu</legend>
        <label
          className={`output-location-option ${
            !usingCustomDirectory ? "is-selected" : ""
          }`}
        >
          <input
            type="radio"
            name="output-location"
            value="same_as_input"
            checked={!usingCustomDirectory}
            onChange={onUseSameDirectory}
          />
          <span>
            <strong>Cùng thư mục với file gốc</strong>
            <small>Mỗi phụ đề được lưu cạnh file nguồn tương ứng.</small>
          </span>
        </label>

        <div
          className={`output-location-option output-location-custom ${
            usingCustomDirectory ? "is-selected" : ""
          }`}
        >
          <label>
            <input
              type="radio"
              name="output-location"
              value="custom_directory"
              checked={usingCustomDirectory}
              onChange={onUseCustomDirectory}
            />
            <span>
              <strong>Một thư mục cho cả batch</strong>
              <small>{batchCopy}</small>
            </span>
          </label>
          <button
            type="button"
            className="output-directory-button"
            onClick={onChooseDirectory}
            disabled={disabled}
          >
            {choosingDirectory
              ? "Đang mở…"
              : options.outputDirectory
                ? "Thay đổi…"
                : "Chọn thư mục…"}
          </button>
        </div>

        {usingCustomDirectory && options.outputDirectory && (
          <div
            className="output-directory-path"
            role="status"
            aria-live="polite"
            title={options.outputDirectory}
          >
            <span aria-hidden="true">↳</span>
            <code>{options.outputDirectory}</code>
          </div>
        )}

        {error && (
          <p className="output-location-error" role="alert">
            {error}
          </p>
        )}
      </fieldset>

      <fieldset className="output-format-group" disabled={disabled}>
        <legend>Định dạng</legend>
        <label className="format-check locked" htmlFor="format-srt">
          <input id="format-srt" type="checkbox" checked readOnly /> SRT
          <small>Bắt buộc</small>
        </label>
        <label className="format-check" htmlFor="format-vtt">
          <input
            id="format-vtt"
            type="checkbox"
            checked={options.includeVtt}
            onChange={(event) =>
              setOptions((current) => ({
                ...current,
                includeVtt: event.target.checked,
              }))
            }
          />
          VTT
        </label>
      </fieldset>
    </section>
  );
}
