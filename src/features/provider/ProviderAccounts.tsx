import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  createProviderAccount,
  deleteProviderAccount,
  listProviderAccounts,
  setActiveProviderAccount,
  testProviderConnection,
  updateProviderAccount,
} from "../../lib/tauri";
import type {
  Provider,
  ProviderAccountState,
  ProviderAccountSummary,
} from "../../lib/types";
import { DEFAULT_PROVIDER_BASE_URLS } from "../../lib/providerAccounts";
import { getProviderStatus, normalizeAccountError } from "./accountPresentation";
import {
  getConnectionResultMessage,
  getEndpointSummary,
  PROVIDER_ACCOUNT_GUIDES,
} from "./providerAccountGuidance";

interface ProviderAccountsProps {
  provider: Provider;
  disabled: boolean;
}

type Editor =
  | { mode: "create" }
  | { mode: "edit"; account: ProviderAccountSummary }
  | null;

type ConnectionTestState =
  | { status: "idle" }
  | { status: "testing"; message: string }
  | { status: "success" | "warning" | "error"; message: string };

const idleConnectionTest: ConnectionTestState = { status: "idle" };

const emptyState: ProviderAccountState = {
  accounts: [],
  activeAccountFile: null,
  warnings: [],
};

const providerNames: Record<Provider, string> = {
  openai: "OpenAI",
  gemini: "Gemini",
};

export function ProviderAccounts({ provider, disabled }: ProviderAccountsProps) {
  const [state, setState] = useState<ProviderAccountState>(emptyState);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<Editor>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [connectionTest, setConnectionTest] = useState<ConnectionTestState>(idleConnectionTest);
  const [guideOpen, setGuideOpen] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const labelInputRef = useRef<HTMLInputElement>(null);
  const editorReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const connectionRequestRef = useRef(0);
  const providerName = providerNames[provider];
  const guide = PROVIDER_ACCOUNT_GUIDES[provider];

  useEffect(() => {
    let disposed = false;
    setState(emptyState);
    setLoading(true);
    setBusy(false);
    setEditor(null);
    setPendingDelete(null);
    setError(null);
    setFeedback("");
    setGuideOpen(true);
    setAdvancedOpen(false);
    editorReturnFocusRef.current = null;
    connectionRequestRef.current += 1;
    setConnectionTest(idleConnectionTest);
    void listProviderAccounts(provider)
      .then((nextState) => {
        if (!disposed) setState(nextState);
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(normalizeAccountError(reason));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [provider]);

  useEffect(() => {
    if (editor) labelInputRef.current?.focus();
  }, [editor]);

  const connectionBusy = connectionTest.status === "testing";
  const mutationsDisabled = disabled || busy || connectionBusy;
  const status = getProviderStatus(provider, state.activeAccountFile, state.accounts.length);
  const labelInputId = `${provider}-account-label`;
  const apiKeyInputId = `${provider}-api-key`;
  const baseUrlInputId = `${provider}-base-url`;
  const editorHeadingId = `${provider}-account-editor-heading`;

  function prepareEditor(trigger: HTMLButtonElement) {
    editorReturnFocusRef.current = trigger;
    setError(null);
    setPendingDelete(null);
    setFeedback("");
    setGuideOpen(true);
    setAdvancedOpen(false);
    connectionRequestRef.current += 1;
    setConnectionTest(idleConnectionTest);
  }

  function beginCreate(event: ReactMouseEvent<HTMLButtonElement>) {
    prepareEditor(event.currentTarget);
    setEditor({ mode: "create" });
  }

  function beginEdit(
    account: ProviderAccountSummary,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) {
    prepareEditor(event.currentTarget);
    setEditor({ mode: "edit", account });
  }

  function closeEditor(focusTarget: "automatic" | "add" = "automatic") {
    connectionRequestRef.current += 1;
    setConnectionTest(idleConnectionTest);
    const editorMode = editor?.mode;
    setEditor(null);
    const trigger = editorReturnFocusRef.current;
      editorReturnFocusRef.current = null;
      window.requestAnimationFrame(() => {
        if (focusTarget === "add" || editorMode === "create") {
          document.getElementById(`${provider}-add-account`)?.focus();
        } else {
          trigger?.focus();
        }
    });
  }

  async function openProviderUrl(url: string, label: string) {
    setError(null);
    try {
      await openUrl(url);
    } catch {
      setError(`Không thể mở ${label}. Hãy thử lại.`);
    }
  }

  async function mutate(
    action: () => Promise<ProviderAccountState>,
    successMessage: string,
  ): Promise<boolean> {
    setBusy(true);
    setError(null);
    setFeedback("");
    try {
      setState(await action());
      setFeedback(successMessage);
      return true;
    } catch (reason) {
      setError(normalizeAccountError(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const label = String(data.get("label") ?? "");
    const apiKey = String(data.get("apiKey") ?? "");
    const baseUrl = String(data.get("baseUrl") ?? "");
    const saved = editor?.mode === "edit"
      ? await mutate(
          () => updateProviderAccount(
            provider,
            editor.account.fileName,
            label,
            apiKey,
            baseUrl,
          ),
          `Đã cập nhật ${label.trim()}.`,
        )
      : await mutate(
          () => createProviderAccount(provider, label, apiKey, baseUrl),
          `Đã thêm ${label.trim()}.`,
        );
    if (saved) {
      form.reset();
      closeEditor();
    }
  }

  async function checkConnection(form: HTMLFormElement) {
    const data = new FormData(form);
    const apiKey = String(data.get("apiKey") ?? "");
    const baseUrl = String(data.get("baseUrl") ?? "");
    const requestId = connectionRequestRef.current + 1;
    connectionRequestRef.current = requestId;
    setError(null);
    setFeedback("");
    setConnectionTest({
      status: "testing",
      message: `Đang kiểm tra kết nối ${providerName}…`,
    });
    try {
      const result = await testProviderConnection(
        provider,
        apiKey,
        baseUrl,
        editor?.mode === "edit" ? editor.account.fileName : undefined,
      );
      if (connectionRequestRef.current !== requestId) return;
      setConnectionTest({
        status: result.outcome === "connected" ? "success" : "warning",
        message: getConnectionResultMessage(provider, result),
      });
    } catch (reason) {
      if (connectionRequestRef.current !== requestId) return;
      setConnectionTest({
        status: "error",
        message: normalizeAccountError(reason),
      });
    }
  }

  const editorBaseUrl = editor?.mode === "edit"
    ? editor.account.baseUrl
    : DEFAULT_PROVIDER_BASE_URLS[provider];

  const accountEditor = editor ? (
    <form
      key={editor.mode === "edit" ? editor.account.fileName : "create"}
      className={`account-form is-${editor.mode}`}
      aria-labelledby={editorHeadingId}
      onSubmit={(event) => void submitAccount(event)}
    >
      <div className="account-form-header">
        <div className="account-form-heading">
          <strong id={editorHeadingId}>
            {editor.mode === "create"
              ? `Thêm ${providerName} API key`
              : `Sửa ${editor.account.label}`}
          </strong>
          <span>Tên file được tạo một lần và không đổi khi bạn đổi label.</span>
        </div>
        <span className="account-editor-state">
          {editor.mode === "create" ? "Tài khoản mới" : "Đang chỉnh sửa"}
        </span>
      </div>

      <div className="account-core-fields">
        <label htmlFor={labelInputId}>
          <span>Tên hiển thị</span>
          <input
            ref={labelInputRef}
            id={labelInputId}
            name="label"
            type="text"
            maxLength={64}
            defaultValue={editor.mode === "edit" ? editor.account.label : ""}
            placeholder="Ví dụ: Công ty"
            autoComplete="off"
            disabled={mutationsDisabled}
            required
          />
        </label>
        <label htmlFor={apiKeyInputId}>
          <span>{providerName} API key</span>
          <input
            id={apiKeyInputId}
            name="apiKey"
            type="password"
            minLength={editor.mode === "create" ? 8 : undefined}
            maxLength={512}
            placeholder={editor.mode === "edit" ? "Để trống để giữ key hiện có" : "Dán API key"}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onInput={() => {
              connectionRequestRef.current += 1;
              setConnectionTest(idleConnectionTest);
            }}
            disabled={mutationsDisabled}
            required={editor.mode === "create"}
          />
          <small>
            File mới dùng mẫu <code>{provider}_ten_account_1.json</code>. File cũ vẫn giữ
            nguyên tên.
            {editor.mode === "edit" && " Để trống khi kiểm tra sẽ dùng key đang lưu."}
          </small>
        </label>
      </div>

      <details
        className="account-guide"
        open={guideOpen}
        onToggle={(event) => setGuideOpen(event.currentTarget.open)}
      >
        <summary>{guide.summary}</summary>
        <div className="account-guide-content">
          <ol>
            {guide.steps.map((step) => <li key={step}>{step}</li>)}
          </ol>
          <a
            className="account-guide-link"
            href={guide.url}
            rel="external noreferrer"
            aria-label={`${guide.linkLabel} trong trình duyệt mặc định`}
            onClick={(event) => {
              event.preventDefault();
              void openProviderUrl(guide.url, `trang hướng dẫn ${providerName}`);
            }}
          >
            {guide.linkLabel}
            <span aria-hidden="true">↗</span>
          </a>
          <small>Không chia sẻ API key. Link chính thức sẽ mở trong trình duyệt mặc định.</small>
        </div>
      </details>

      <details
        className="account-advanced"
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary>
          <span>Tùy chọn nâng cao</span>
          <small>{getEndpointSummary(provider, editorBaseUrl)}</small>
        </summary>
        <div className="account-advanced-content">
          <label htmlFor={baseUrlInputId}>
            <span>Base URL <em>(không bắt buộc thay đổi)</em></span>
            <input
              id={baseUrlInputId}
              name="baseUrl"
              type="url"
              inputMode="url"
              maxLength={2048}
              defaultValue={editorBaseUrl}
              placeholder={DEFAULT_PROVIDER_BASE_URLS[provider]}
              autoComplete="url"
              autoCapitalize="none"
              spellCheck={false}
              onInput={() => {
                connectionRequestRef.current += 1;
                setConnectionTest(idleConnectionTest);
              }}
              disabled={mutationsDisabled}
            />
            <small>
              Giữ endpoint mặc định, hoặc thay bằng HTTPS gateway/proxy của bạn. HTTP chỉ
              dành cho loopback local; để trống khi lưu sẽ khôi phục mặc định.
            </small>
          </label>
        </div>
      </details>

      <small className="account-probe-note">
        Khi kiểm tra, WhisperSub chỉ gọi Models API; không gửi media hoặc transcript.
        {provider === "openai"
          ? " Kết quả không xác nhận billing, credit hoặc khả năng tạo bản dịch."
          : " Kết quả kiểm tra không bắt buộc để lưu."}
      </small>

      <div className="account-form-actions">
        <button type="submit" className="account-save-button" disabled={mutationsDisabled}>
          {busy ? "Đang lưu…" : "Lưu tài khoản"}
        </button>
        <button
          type="button"
          className="account-test-button"
          disabled={mutationsDisabled}
          onClick={(event) => {
            const form = event.currentTarget.form;
            if (form) void checkConnection(form);
          }}
        >
          {connectionBusy ? "Đang kiểm tra…" : "Kiểm tra kết nối"}
        </button>
        <button
            type="button"
            className="account-cancel-button"
            disabled={mutationsDisabled}
            onClick={() => closeEditor()}
        >
          Hủy
        </button>
      </div>

      {connectionTest.status !== "idle" && (
        <p
          className={`account-connection-result is-${connectionTest.status}`}
          role={connectionTest.status === "error" ? "alert" : "status"}
        >
          {connectionTest.message}
        </p>
      )}
    </form>
  ) : null;

  return (
    <section
      className="account-manager"
      aria-labelledby={`${provider}-accounts-heading`}
      aria-busy={loading || busy || connectionBusy}
    >
      <div className="account-heading">
        <div>
          <h2 id={`${provider}-accounts-heading`}>Tài khoản {providerName}</h2>
          <p>Account có thể dùng để dịch transcript; mỗi batch vẫn cần consent riêng.</p>
        </div>
        {!loading && (
          editor ? (
            <span className="account-editing-state">Đang mở trình chỉnh sửa</span>
          ) : (
            <button
              type="button"
              id={`${provider}-add-account`}
              className="account-add-button"
              onClick={beginCreate}
              disabled={mutationsDisabled}
            >
              <span aria-hidden="true">＋</span>
              Thêm API key
            </button>
          )
        )}
      </div>

      <div
        className={`account-provider-status${state.activeAccountFile ? " is-ready" : ""}`}
      >
        <span className="account-provider-status-mark" aria-hidden="true">
          {state.activeAccountFile ? "✓" : "i"}
        </span>
        <div>
          <strong>{status.title}</strong>
          <p>{status.detail}</p>
        </div>
      </div>

      {guide.readiness && (
        <aside className="account-readiness-note" aria-label="OpenAI translation readiness">
          <div>
            <strong>{guide.readiness.title}</strong>
            <p>{guide.readiness.detail}</p>
          </div>
          <div className="account-readiness-links">
            {guide.readiness.links.map((link) => (
              <a
                key={link.url}
                href={link.url}
                rel="external noreferrer"
                aria-label={`${link.label} trong trình duyệt mặc định`}
                onClick={(event) => {
                  event.preventDefault();
                  void openProviderUrl(link.url, link.label);
                }}
              >
                {link.label}
                <span aria-hidden="true">↗</span>
              </a>
            ))}
          </div>
        </aside>
      )}

      {editor?.mode === "create" && accountEditor}

      {loading ? (
        <div className="account-skeleton" aria-label={`Đang tải tài khoản ${providerName}`}>
          <span />
          <span />
        </div>
      ) : state.accounts.length ? (
        <ul className="account-list" aria-label={`Danh sách tài khoản ${providerName}`}>
          {state.accounts.map((account) => (
            <Fragment key={account.fileName}>
                <li
                  className={`account-row${
                    editor?.mode === "edit" && editor.account.fileName === account.fileName
                      ? " is-editing"
                      : ""
                  }`}
                >
                <div className="account-meta">
                  <strong>{account.label}</strong>
                  <span>{account.isActive ? `Đang dùng · ${account.fileName}` : account.fileName}</span>
                  <span className="account-endpoint">Endpoint · {account.baseUrl}</span>
                </div>
              {pendingDelete === account.fileName ? (
                <div
                  className="account-confirm"
                  role="group"
                  aria-label={`Xác nhận xóa ${account.label}`}
                >
                  <span>Xóa “{account.label}”? Thao tác này không thể hoàn tác.</span>
                  <button
                    type="button"
                    className="account-action danger"
                    disabled={mutationsDisabled}
                    onClick={() => {
                      void mutate(
                          () => deleteProviderAccount(provider, account.fileName),
                          `Đã xóa ${account.label}.`,
                        ).then((deleted) => {
                          if (!deleted) return;
                          setPendingDelete(null);
                          if (
                            editor?.mode === "edit" &&
                            editor.account.fileName === account.fileName
                          ) {
                            closeEditor("add");
                          }
                        });
                    }}
                  >
                    Xóa tài khoản
                  </button>
                  <button
                    type="button"
                    className="account-action"
                    onClick={() => setPendingDelete(null)}
                    disabled={mutationsDisabled}
                  >
                    Giữ lại
                  </button>
                </div>
              ) : (
                <div className="account-actions">
                  {!account.isActive && (
                    <button
                      type="button"
                      className="account-action"
                      disabled={mutationsDisabled}
                      onClick={() => {
                        void mutate(
                          () => setActiveProviderAccount(provider, account.fileName),
                          `Đang dùng ${account.label}.`,
                        );
                      }}
                    >
                      Chọn tài khoản
                    </button>
                  )}
                  <button
                    type="button"
                    className="account-action"
                    disabled={mutationsDisabled}
                    onClick={(event) => beginEdit(account, event)}
                  >
                    Sửa
                  </button>
                  <button
                    type="button"
                    className="account-action danger"
                    disabled={mutationsDisabled}
                    onClick={() => setPendingDelete(account.fileName)}
                  >
                    Xóa
                  </button>
                </div>
              )}
              </li>
              {editor?.mode === "edit" && editor.account.fileName === account.fileName && (
                <li className="account-editor-row">{accountEditor}</li>
              )}
            </Fragment>
          ))}
        </ul>
      ) : (
        <div className="account-empty">
          <span className="account-empty-mark" aria-hidden="true">⌁</span>
          <strong>Chưa có API key {providerName}</strong>
          <p>Thêm account đầu tiên; account đó sẽ được chọn mặc định.</p>
        </div>
      )}

      {disabled && (
          <p className="account-disabled-note">
            Không thể đổi tài khoản trong khi cấu hình batch đang bị khóa.
          </p>
      )}
      {state.warnings.map((warning) => (
        <p className="account-warning" role="status" key={warning}>{warning}</p>
      ))}
      {error && <p className="account-error" role="alert">{error}</p>}
      <p className="account-feedback" aria-live="polite">{feedback}</p>
    </section>
  );
}
