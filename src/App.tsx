import { DropZone } from "./components/DropZone";
import { JobList } from "./components/JobList";
import { useJobQueue } from "./features/job/useJobQueue";

const modelLabels: Record<string, string> = {
  tiny: "Tiny",
  base: "Base",
  small: "Small · đề xuất",
  medium: "Medium",
  turbo: "Turbo",
};

const languageLabels: Record<string, string> = {
  auto: "Tự nhận diện",
  vi: "Tiếng Việt",
  en: "English",
};

const deviceLabels: Record<string, string> = {
  auto: "Tự động",
  mps: "Apple GPU",
  cpu: "CPU",
};

function App() {
  const {
    jobs,
    activeJob,
    options,
    setOptions,
    queueRunning,
    chooseFiles,
    startQueue,
    cancelCurrent,
    removeJob,
    clearFinished,
  } = useJobQueue();

  const finishedCount = jobs.filter((job) => job.status === "completed").length;
  const canStart = jobs.some((job) => job.status === "queued") && !queueRunning;
  const latestSegment = activeJob?.segments[activeJob.segments.length - 1];

  return (
    <main className="app-shell">
          <header className="topbar">
            <a className="brand" href="#top" aria-label="WhisperSub trang chính">
              <span className="brand-mark">W</span>
            <span>
              <strong>WhisperSub</strong>
              <small>Studio phụ đề cục bộ</small>
            </span>
          </a>
          <div className="privacy-badge">
            <span className="privacy-dot" />
            Xử lý cục bộ · Media không rời khỏi máy
          </div>
        </header>

        <section className="app-intro" id="top">
          <div className="intro-copy">
            <h1>Tạo phụ đề ngay trên máy Mac</h1>
            <p>
              Thêm video, kiểm tra tùy chỉnh khi cần, rồi theo dõi từng file trong một hàng đợi.
            </p>
          </div>
          <div className="preview-note" role="note">
            <strong>Bản xem trước</strong>
            <span>Luồng xử lý đang được mô phỏng và chưa tạo file phụ đề thật.</span>
          </div>
        </section>

        <section className="workspace">
          <div className="queue-panel">
            <div className="section-heading queue-heading">
              <div>
                <h2>Hàng đợi</h2>
                <p>Thêm nhiều file và xử lý tuần tự để giữ máy luôn ổn định.</p>
              </div>
              {finishedCount > 0 && (
                <button type="button" className="text-button" onClick={clearFinished}>
                  Dọn file đã xong
                </button>
              )}
            </div>

            <DropZone onChoose={() => void chooseFiles()} disabled={queueRunning} />
            <JobList jobs={jobs} onRemove={removeJob} />

            {latestSegment && (
              <div className="live-segment" aria-live="polite">
                <strong>Bản xem trước transcript</strong>
                <p>“{latestSegment.text}”</p>
              </div>
            )}

            <div className="action-row">
              <div aria-live="polite">
                <span className="queue-count">{jobs.length} file đã chọn</span>
                <small>
                  {activeJob
                    ? `Đang xử lý: ${activeJob.fileName}`
                    : jobs.length
                      ? "Sẵn sàng tạo phụ đề"
                      : "Chọn video để bắt đầu"}
                </small>
              </div>
              {activeJob ? (
                <button className="secondary-button" type="button" onClick={() => void cancelCurrent()}>
                  Hủy file hiện tại
                </button>
              ) : (
                <button className="primary-button" type="button" onClick={startQueue} disabled={!canStart}>
                  Tạo phụ đề
                  <span aria-hidden="true">→</span>
                </button>
              )}
            </div>
          </div>

          <details className="settings-panel">
            <summary className="settings-summary">
              <span>
                <strong>Tùy chỉnh xử lý</strong>
                <small>
                  {modelLabels[options.model]} · {languageLabels[options.sourceLanguage]} · {deviceLabels[options.device]}
                </small>
              </span>
              <span className="disclosure-icon" aria-hidden="true">+</span>
            </summary>

            <div className="settings-content">
              <p className="settings-hint">
                Thiết lập mặc định phù hợp với hầu hết video. Chỉ thay đổi khi bạn cần ưu tiên tốc độ hoặc chất lượng.
              </p>

              <label htmlFor="whisper-model">
                <span>Mô hình Whisper</span>
                <select
                  id="whisper-model"
                  value={options.model}
                  onChange={(event) =>
                    setOptions({ ...options, model: event.target.value as typeof options.model })
                  }
                  disabled={queueRunning}
                >
                  <option value="tiny">Tiny · nhanh nhất</option>
                  <option value="base">Base · nhẹ</option>
                  <option value="small">Small · đề xuất</option>
                  <option value="medium">Medium · chất lượng cao</option>
                  <option value="turbo">Turbo · ưu tiên tốc độ</option>
                </select>
              </label>

                <label htmlFor="source-language">
                  <span>Ngôn ngữ audio</span>
                  <select
                    id="source-language"
                    value={options.sourceLanguage}
                    onChange={(event) =>
                      setOptions({
                        ...options,
                        sourceLanguage: event.target.value as typeof options.sourceLanguage,
                      })
                    }
                    disabled={queueRunning}
                  >
                    <option value="auto">Tự nhận diện</option>
                    <option value="vi">Tiếng Việt</option>
                    <option value="en">English</option>
                  </select>
                </label>
                <label htmlFor="compute-device">
                  <span>Thiết bị xử lý</span>
                  <select
                    id="compute-device"
                    value={options.device}
                    onChange={(event) =>
                      setOptions({ ...options, device: event.target.value as typeof options.device })
                    }
                  disabled={queueRunning}
                >
                  <option value="auto">Tự động · đề xuất</option>
                  <option value="mps">Apple GPU (MPS)</option>
                  <option value="cpu">CPU</option>
                </select>
              </label>

              <div className="output-card">
                <div>
                  <strong>Định dạng phụ đề</strong>
                  <small>Lưu cạnh file gốc</small>
                </div>
                <label className="format-check locked" htmlFor="format-srt">
                  <input id="format-srt" type="checkbox" checked readOnly /> SRT
                </label>
                <label className="format-check" htmlFor="format-vtt">
                  <input
                    id="format-vtt"
                    type="checkbox"
                    checked={options.includeVtt}
                    onChange={(event) =>
                      setOptions({ ...options, includeVtt: event.target.checked })
                    }
                    disabled={queueRunning}
                  />
                  VTT
                </label>
              </div>

              <div className="provider-note">
                <strong>Riêng tư</strong>
                <p>Dịch tự động đang tắt. Transcript không được gửi ra dịch vụ bên ngoài.</p>
              </div>
            </div>
          </details>
        </section>

        <footer>
          <span>WhisperSub · macOS Apple Silicon</span>
          <span>Bản xem trước chưa tạo file đầu ra</span>
        </footer>
    </main>
  );
}

export default App;
