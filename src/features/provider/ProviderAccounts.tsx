import { useEffect, useRef, useState, type FormEvent } from "react";
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
  const labelInputRef = useRef<HTMLInputElement>(null);
  const connectionRequestRef = useRef(0);
  const providerName = providerNames[provider];

  useEffect(() => {
    let disposed = false;
    setState(emptyState);
    setLoading(true);
    setBusy(false);
    setEditor(null);
    setPendingDelete(null);
    setError(null);
    setFeedback("");
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
      connectionRequestRef.current += 1;
      setConnectionTest(idleConnectionTest);
      setEditor(null);
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
        message: result.message,
      });
    } catch (reason) {
      if (connectionRequestRef.current !== requestId) return;
      setConnectionTest({
        status: "error",
        message: normalizeAccountError(reason),
      });
    }
  }

  return (
    <section
      className="account-manager"
      aria-labelledby={`${provider}-accounts-heading`}
      aria-busy={loading || busy || connectionBusy}
    >
      <div className="account-heading">
        <div>
          <p className="eyebrow">{providerName} API key</p>
          <h2 id={`${provider}-accounts-heading`}>Tài khoản {providerName}</h2>
            <p>Account có thể dùng để dịch transcript; mỗi batch vẫn cần consent riêng.</p>
        </div>
        {!loading && !editor && (
          <button
            type="button"
            className="account-add-button"
            onClick={() => {
              setError(null);
              setPendingDelete(null);
              connectionRequestRef.current += 1;
              setConnectionTest(idleConnectionTest);
              setEditor({ mode: "create" });
            }}
            disabled={mutationsDisabled}
          >
            <span aria-hidden="true">＋</span>
            Thêm API key
          </button>
        )}
      </div>

      <div className="account-provider-status">
        <strong>{status.title}</strong>
        <p>{status.detail}</p>
      </div>

      {loading ? (
        <div className="account-skeleton" aria-label={`Đang tải tài khoản ${providerName}`}>
          <span />
          <span />
        </div>
      ) : state.accounts.length ? (
        <ul className="account-list" aria-label={`Danh sách tài khoản ${providerName}`}>
          {state.accounts.map((account) => (
            <li className="account-row" key={account.fileName}>
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
                        if (deleted) setPendingDelete(null);
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
                      onClick={() => {
                        setError(null);
                        setPendingDelete(null);
                        connectionRequestRef.current += 1;
                        setConnectionTest(idleConnectionTest);
                        setEditor({ mode: "edit", account });
                    }}
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
          ))}
        </ul>
      ) : (
        <div className="account-empty">
          <span className="account-empty-mark" aria-hidden="true">⌁</span>
          <strong>Chưa có API key {providerName}</strong>
          <p>Thêm account đầu tiên; account đó sẽ được chọn mặc định.</p>
        </div>
      )}

      {editor && (
        <form className="account-form" onSubmit={(event) => void submitAccount(event)}>
          <div className="account-form-heading">
            <strong>
              {editor.mode === "create" ? `Thêm ${providerName} API key` : `Sửa ${editor.account.label}`}
            </strong>
            <span>Tên file được tạo một lần và không đổi khi bạn đổi label.</span>
          </div>
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
                spellCheck={false}
                onInput={() => {
                  connectionRequestRef.current += 1;
                  setConnectionTest(idleConnectionTest);
                }}
                disabled={mutationsDisabled}
                required={editor.mode === "create"}
              />
                <small>
                  File mới dùng mẫu <code>{provider}_ten_account_1.json</code>. File cũ vẫn giữ nguyên tên.
                  {editor.mode === "edit" && " Để trống khi kiểm tra sẽ dùng key đang lưu."}
                </small>
            </label>
            <label htmlFor={baseUrlInputId}>
              <span>Base URL <em>(không bắt buộc thay đổi)</em></span>
              <input
                id={baseUrlInputId}
                name="baseUrl"
                type="url"
                inputMode="url"
                maxLength={2048}
                defaultValue={
                  editor.mode === "edit"
                    ? editor.account.baseUrl
                    : DEFAULT_PROVIDER_BASE_URLS[provider]
                }
                placeholder={DEFAULT_PROVIDER_BASE_URLS[provider]}
                  autoComplete="url"
                  spellCheck={false}
                  onInput={() => {
                    connectionRequestRef.current += 1;
                    setConnectionTest(idleConnectionTest);
                  }}
                  disabled={mutationsDisabled}
              />
              <small>
                Giữ endpoint mặc định ở trên, hoặc thay bằng HTTPS gateway/proxy của bạn.
                HTTP chỉ dành cho loopback local; để trống khi lưu sẽ khôi phục mặc định.
              </small>
              </label>
              <small className="account-probe-note">
                Chỉ gọi Models API khi bạn bấm kiểm tra; không gửi media hoặc transcript và
                không lưu key mới.
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
                onClick={() => {
                  connectionRequestRef.current += 1;
                  setConnectionTest(idleConnectionTest);
                  setEditor(null);
                }}
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
      )}

      {disabled && (
        <p className="account-disabled-note">Không thể đổi tài khoản trong khi hàng đợi đang chạy.</p>
      )}
      {state.warnings.map((warning) => (
        <p className="account-warning" role="status" key={warning}>{warning}</p>
      ))}
      {error && <p className="account-error" role="alert">{error}</p>}
      <p className="account-feedback" aria-live="polite">{feedback}</p>
    </section>
  );
}
