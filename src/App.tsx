import { useEffect, useRef, useState } from "react";
import {
  BrandWaveform,
  CloseIcon,
  DashboardIcon,
  KeyIcon,
  MenuIcon,
  SidebarToggleIcon,
} from "./components/AppIcons";
import { DropZone } from "./components/DropZone";
import { JobList } from "./components/JobList";
import { targetLanguageChoices } from "./features/job/targetLanguage";
import { useJobQueue } from "./features/job/useJobQueue";
import { parseHashRoute } from "./features/navigation/hashRoute";
import {
  readSidebarCollapsed,
  writeSidebarCollapsed,
} from "./features/navigation/sidebarPreference";
import { ApiKeysPage } from "./features/provider/ApiKeysPage";
import { TranslationConfig } from "./features/provider/TranslationConfig";

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

function getLocalPreferenceStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function App() {
  const [route, setRoute] = useState(() => parseHashRoute(window.location.hash));
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    readSidebarCollapsed(getLocalPreferenceStorage()),
  );
  const navigationButtonRef = useRef<HTMLButtonElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const {
    jobs,
    activeJob,
    options,
    setOptions,
    queueRunning,
    targetLanguageReadiness,
    chooseFiles,
    startQueue,
    cancelCurrent,
    removeJob,
    clearFinished,
  } = useJobQueue();

  useEffect(() => {
    const syncRoute = () => {
      setRoute(parseHashRoute(window.location.hash));
      setNavigationOpen(false);
    };
    window.addEventListener("hashchange", syncRoute);
    return () => window.removeEventListener("hashchange", syncRoute);
  }, []);

  useEffect(() => {
    writeSidebarCollapsed(sidebarCollapsed, getLocalPreferenceStorage());
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!navigationOpen) return;

    const handleNavigationKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setNavigationOpen(false);
        navigationButtonRef.current?.focus();
        return;
      }

      if (event.key !== "Tab") return;
      const drawerLinks = Array.from(
        navigationRef.current?.querySelectorAll<HTMLElement>("a[href]") ?? [],
      );
      const focusableElements = [navigationButtonRef.current, ...drawerLinks].filter(
        (element): element is HTMLElement => element !== null,
      );
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (!firstElement || !lastElement) return;

      const currentIndex = focusableElements.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? currentIndex <= 0
          ? focusableElements.length - 1
          : currentIndex - 1
        : currentIndex < 0 || currentIndex === focusableElements.length - 1
          ? 0
          : currentIndex + 1;
      event.preventDefault();
      focusableElements[nextIndex].focus();
    };

    window.addEventListener("keydown", handleNavigationKeyDown);
    return () => {
      window.removeEventListener("keydown", handleNavigationKeyDown);
    };
  }, [navigationOpen]);

  const finishedCount = jobs.filter((job) => job.status === "completed").length;
  const canStart =
    jobs.some((job) => job.status === "queued") &&
    !queueRunning &&
    targetLanguageReadiness.ready;
  const latestSegment = activeJob?.segments[activeJob.segments.length - 1];
  const appShellClassName = [
    "app-shell",
    sidebarCollapsed ? "sidebar-collapsed" : "",
    navigationOpen ? "navigation-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <main className={appShellClassName}>
      <header className="topbar">
        <button
          ref={navigationButtonRef}
          className="navigation-toggle"
          type="button"
          aria-label={navigationOpen ? "Đóng menu" : "Mở menu"}
          aria-controls="primary-navigation"
          aria-expanded={navigationOpen}
          onClick={() => setNavigationOpen((open) => !open)}
        >
          {navigationOpen ? <CloseIcon /> : <MenuIcon />}
        </button>

        <a className="brand" href="#dashboard" aria-label="WhisperSub Dashboard">
          <span className="brand-mark" aria-hidden="true">
            <BrandWaveform />
          </span>
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

      <aside ref={navigationRef} className="sidebar" id="primary-navigation">
        <button
          className="sidebar-collapse-control"
          type="button"
          aria-label={sidebarCollapsed ? "Mở rộng menu" : "Thu gọn menu"}
          aria-controls="primary-navigation-links"
          aria-expanded={!sidebarCollapsed}
          title={sidebarCollapsed ? "Mở rộng menu" : "Thu gọn menu"}
          onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
        >
          <SidebarToggleIcon expanded={!sidebarCollapsed} />
          <span className="sidebar-collapse-label">
            {sidebarCollapsed ? "Mở rộng menu" : "Thu gọn menu"}
          </span>
        </button>

        <nav
          id="primary-navigation-links"
          className="primary-nav"
          aria-label="Điều hướng chính"
        >
          <a
            className="primary-nav-link"
            href="#dashboard"
            aria-current={route.page === "dashboard" ? "page" : undefined}
            aria-label="Dashboard"
            title="Dashboard"
          >
            <DashboardIcon className="primary-nav-icon" />
            <span className="primary-nav-label">Dashboard</span>
          </a>
          <a
            className="primary-nav-link"
            href={route.page === "apiKeys" ? `#api-keys/${route.provider}` : "#api-keys/openai"}
            aria-current={route.page === "apiKeys" ? "page" : undefined}
            aria-label="API Keys"
            title="API Keys"
          >
            <KeyIcon className="primary-nav-icon" />
            <span className="primary-nav-label">API Keys</span>
          </a>
        </nav>

        <div className="sidebar-meta" aria-label="Thông tin ứng dụng">
          <span>WhisperSub</span>
          <small>macOS Apple Silicon</small>
        </div>
      </aside>

      <button
        className="navigation-backdrop"
        type="button"
        aria-label="Đóng menu"
        tabIndex={-1}
        onClick={() => {
          setNavigationOpen(false);
          navigationButtonRef.current?.focus();
        }}
      />

      <div className="app-main">
        <div className="app-content">

      {route.page === "dashboard" ? (
        <>
            <section className="app-intro" id="dashboard">
              <div className="intro-copy">
                <h1>Tạo phụ đề</h1>
                <p>
                  Thêm nhiều video, chọn cách xử lý và theo dõi từng file. Media luôn ở trên máy.
                </p>
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
                          ? targetLanguageReadiness.ready
                            ? "Sẵn sàng tạo phụ đề"
                            : targetLanguageReadiness.reason
                          : "Chọn video để bắt đầu"}
                  </small>
                </div>
                {activeJob ? (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void cancelCurrent()}
                  >
                    Hủy file hiện tại
                  </button>
                ) : (
                  <button
                    className="primary-button"
                    type="button"
                    onClick={startQueue}
                    disabled={!canStart}
                  >
                    Tạo phụ đề
                    <span aria-hidden="true">→</span>
                  </button>
                )}
              </div>
            </div>

              <details className="settings-panel" open>
                <summary className="settings-summary">
                  <span>
                    <strong>Tùy chỉnh xử lý</strong>
                    <small>
                      {modelLabels[options.model]} · Audio: {languageLabels[options.sourceLanguage]} ·{" "}
                      {deviceLabels[options.device]} · Phụ đề: {languageLabels[options.targetLanguage]}
                    </small>
                  </span>
                  <span className="disclosure-action" aria-hidden="true">
                    <span className="disclosure-label disclosure-label-open">Thu gọn</span>
                    <span className="disclosure-label disclosure-label-closed">Mở tùy chỉnh</span>
                    <span className="disclosure-chevron">⌄</span>
                  </span>
                </summary>

                <div className="settings-content">
                  <p className="settings-hint">
                    Nhận dạng luôn chạy local. Chỉ khi chọn ngôn ngữ đích và xác nhận,
                    transcript text mới được gửi tới provider đã chọn để dịch.
                  </p>

                  <div className="settings-basic-grid">
                    <label htmlFor="whisper-model">
                      <span>Mô hình Whisper</span>
                      <select
                        id="whisper-model"
                        value={options.model}
                        onChange={(event) =>
                          setOptions({
                            ...options,
                            model: event.target.value as typeof options.model,
                          })
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
                      <span>Ngôn ngữ được nói</span>
                      <select
                        id="source-language"
                        aria-describedby="source-language-help"
                        value={options.sourceLanguage}
                        onChange={(event) =>
                          setOptions({
                            ...options,
                            sourceLanguage: event.target.value as typeof options.sourceLanguage,
                          })
                        }
                        disabled={queueRunning}
                      >
                        <option value="auto">Tự nhận diện · Việt + Anh</option>
                        <option value="vi">Chủ yếu tiếng Việt</option>
                        <option value="en">Chủ yếu English</option>
                      </select>
                      <small id="source-language-help" className="field-help">
                        Audio Việt–Anh nên dùng Tự nhận diện.
                      </small>
                    </label>

                    <label htmlFor="target-language">
                      <span>Ngôn ngữ phụ đề</span>
                      <select
                        id="target-language"
                        aria-describedby="target-language-help"
                        value={options.targetLanguage}
                        onChange={(event) => {
                          setOptions({
                            ...options,
                            targetLanguage: event.target.value as typeof options.targetLanguage,
                            translationConsent: false,
                          });
                        }}
                        disabled={queueRunning}
                      >
                        {targetLanguageChoices.map((choice) => (
                          <option
                            key={choice.value}
                            value={choice.value}
                            disabled={!choice.available}
                          >
                            {choice.label}
                          </option>
                        ))}
                      </select>
                      <small id="target-language-help" className="field-help">
                        {options.targetLanguage === "none"
                          ? "Giữ nguyên ngôn ngữ được nói."
                          : targetLanguageReadiness.ready
                            ? "Sẵn sàng dịch bằng account và model đã chọn."
                            : targetLanguageReadiness.reason}
                      </small>
                    </label>

                    <label htmlFor="compute-device">
                      <span>Thiết bị xử lý</span>
                      <select
                        id="compute-device"
                        value={options.device}
                        onChange={(event) =>
                          setOptions({
                            ...options,
                            device: event.target.value as typeof options.device,
                          })
                        }
                        disabled={queueRunning}
                      >
                        <option value="auto">Tự động · đề xuất</option>
                        <option value="mps">Apple GPU (MPS)</option>
                        <option value="cpu">CPU</option>
                      </select>
                    </label>
                  </div>

                  {options.targetLanguage !== "none" && (
                    <TranslationConfig
                      options={options}
                      setOptions={setOptions}
                      queueRunning={queueRunning}
                    />
                  )}

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
              </div>
            </details>
          </section>
        </>
      ) : (
        <ApiKeysPage provider={route.provider} disabled={queueRunning} />
      )}

          <footer>
            <span>WhisperSub · macOS Apple Silicon</span>
            <span>{queueRunning ? "Hàng đợi vẫn đang chạy" : "Auto phù hợp cho audio Việt–Anh"}</span>
          </footer>
        </div>
      </div>
    </main>
  );
}

export default App;
