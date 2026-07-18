import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { listProviderAccounts, listProviderModels } from "../../lib/tauri";
import type {
  JobOptions,
  Provider,
  ProviderAccountSummary,
  ProviderModelSummary,
} from "../../lib/types";
import {
  curateTranslationModels,
  defaultTranslationModel,
  translationModelGroups,
  ungroupedModelLabel,
} from "./translationModelCatalog";

const providerMeta: Record<
  Provider,
  { name: string; accountHref: string; generationApi: string }
> = {
  openai: {
    name: "OpenAI",
    accountHref: "#api-keys/openai",
    generationApi: "Responses API",
  },
  gemini: {
    name: "Gemini",
    accountHref: "#api-keys/gemini",
    generationApi: "Generate Content API",
  },
};

interface TranslationConfigProps {
  options: JobOptions;
  setOptions: Dispatch<SetStateAction<JobOptions>>;
  queueRunning: boolean;
}

function isOfficialEndpoint(provider: Provider, baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname;
    return provider === "openai"
      ? hostname === "api.openai.com"
      : hostname === "generativelanguage.googleapis.com";
  } catch {
    return false;
  }
}

export function TranslationConfig({
  options,
  setOptions,
  queueRunning,
}: TranslationConfigProps) {
  const [accounts, setAccounts] = useState<ProviderAccountSummary[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState("");
  const [models, setModels] = useState<ProviderModelSummary[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [manualModel, setManualModel] = useState(false);
  const [modelRefresh, setModelRefresh] = useState(0);

  const provider = options.translationProvider;
  const meta = providerMeta[provider];
  const selectedAccount = accounts.find(
    (account) => account.fileName === options.providerAccountFile,
  );
  const selectedModelIsListed = models.some((model) => model.id === options.providerModel);
  const modelGroups = translationModelGroups(provider, models);

  useEffect(() => {
    let disposed = false;
    setAccountsLoading(true);
    setAccountsError("");
    setAccounts([]);
    void listProviderAccounts(provider)
      .then((state) => {
        if (disposed) return;
        setAccounts(state.accounts);
        setOptions((current) => {
          if (current.translationProvider !== provider) return current;
          const selectedStillExists = state.accounts.some(
            (account) => account.fileName === current.providerAccountFile,
          );
          const nextAccount = selectedStillExists
            ? current.providerAccountFile
            : state.activeAccountFile ?? state.accounts[0]?.fileName ?? null;
          if (nextAccount === current.providerAccountFile) return current;
          return {
            ...current,
            providerAccountFile: nextAccount,
            providerModel: "",
            translationConsent: false,
          };
        });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setAccountsError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!disposed) setAccountsLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [provider, setOptions]);

  useEffect(() => {
    const fileName = options.providerAccountFile;
    if (!fileName) {
      setModels([]);
      setModelsError("");
      setModelsLoading(false);
      return;
    }

    let disposed = false;
    setModelsLoading(true);
    setModelsError("");
    void listProviderModels(provider, fileName)
        .then((catalogModels) => {
          if (disposed) return;
          const nextModels = curateTranslationModels(provider, catalogModels);
          setModels(nextModels);
        setOptions((current) => {
          if (
            current.translationProvider !== provider ||
            current.providerAccountFile !== fileName
          ) {
            return current;
          }
          if (current.providerModel.trim()) return current;
            const nextModel = defaultTranslationModel(provider, nextModels);
          return nextModel
            ? { ...current, providerModel: nextModel, translationConsent: false }
            : current;
        });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setModels([]);
        setModelsError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!disposed) setModelsLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [modelRefresh, options.providerAccountFile, provider, setOptions]);

  const useCatalogModel = () => {
    setManualModel(false);
    const nextModel = selectedModelIsListed
      ? options.providerModel
      : defaultTranslationModel(provider, models);
    setOptions({ ...options, providerModel: nextModel, translationConsent: false });
  };

  return (
    <div className="translation-config" aria-labelledby="translation-config-title">
      <div className="translation-config-heading">
        <strong id="translation-config-title">Dịch transcript bằng {meta.name}</strong>
        <span>Media và timestamp không được gửi.</span>
      </div>

        <div className="translation-fields">
          <label htmlFor="translation-provider">
            <span>Provider dịch</span>
            <select
              id="translation-provider"
              value={provider}
              onChange={(event) => {
                const nextProvider = event.target.value as Provider;
                setManualModel(false);
                setModels([]);
                setModelsError("");
                setOptions({
                  ...options,
                  translationProvider: nextProvider,
                  providerAccountFile: null,
                  providerModel: "",
                  translationConsent: false,
                });
              }}
              disabled={queueRunning}
            >
              <option value="openai">OpenAI</option>
              <option value="gemini">Gemini</option>
            </select>
          </label>

          <label htmlFor="translation-account">
            <span>{meta.name} account</span>
            <select
              id="translation-account"
              value={options.providerAccountFile ?? ""}
              onChange={(event) => {
                setManualModel(false);
                setModels([]);
                setOptions({
                  ...options,
                  providerAccountFile: event.target.value || null,
                  providerModel: "",
                  translationConsent: false,
                });
              }}
              disabled={queueRunning || accountsLoading}
            >
              <option value="">
                {accountsLoading ? "Đang tải account…" : `Chọn ${meta.name} account`}
              </option>
              {accounts.map((account) => (
                <option key={account.fileName} value={account.fileName}>
                  {account.label}
                  {account.isActive ? " · đang dùng" : ""}
                </option>
              ))}
            </select>
            <small className="field-help" aria-live="polite">
              {accountsError ? (
                `Không đọc được account: ${accountsError}`
              ) : accounts.length === 0 && !accountsLoading ? (
                <>
              Chưa có {meta.name} account. <a href={meta.accountHref}>Thêm trong API Keys</a>.
                </>
              ) : selectedAccount ? (
                <>
                  API key được Rust đọc khi gọi model/dịch. Endpoint: {" "}
                  <code>{selectedAccount.baseUrl}</code>.
                </>
              ) : (
                "Chọn account để tải model và xem endpoint sẽ nhận transcript."
              )}
            </small>
          </label>

          <label className="translation-model-field" htmlFor="translation-model">
            <span>Model dịch</span>
            {manualModel ? (
              <input
                id="translation-model"
                value={options.providerModel}
                onChange={(event) =>
                  setOptions({
                    ...options,
                    providerModel: event.target.value,
                    translationConsent: false,
                  })
                }
                disabled={queueRunning}
                autoComplete="off"
                spellCheck={false}
              />
            ) : (
              <select
                id="translation-model"
                value={selectedModelIsListed ? options.providerModel : ""}
                onChange={(event) =>
                  setOptions({
                    ...options,
                    providerModel: event.target.value,
                    translationConsent: false,
                  })
                }
                disabled={queueRunning || modelsLoading || !options.providerAccountFile}
              >
                <option value="">
                  {modelsLoading ? "Đang tải model…" : "Chọn model"}
                </option>
                  {provider === "gemini"
                    ? modelGroups.map((group) => (
                        <optgroup key={group.id} label={group.label}>
                          {group.options.map((option) => (
                            <option key={option.model.id} value={option.model.id}>
                              {option.label}
                            </option>
                          ))}
                        </optgroup>
                      ))
                    : models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {ungroupedModelLabel(model)}
                        </option>
                      ))}
              </select>
            )}
            <div className="translation-model-actions">
              <button
                type="button"
                className="inline-action-button"
                onClick={() => setModelRefresh((value) => value + 1)}
                disabled={queueRunning || modelsLoading || !options.providerAccountFile}
              >
                Tải lại model
              </button>
              <button
                type="button"
                className="inline-action-button"
                onClick={() => (manualModel ? useCatalogModel() : setManualModel(true))}
                disabled={queueRunning}
              >
                {manualModel ? "Dùng danh sách account" : "Nhập model thủ công"}
              </button>
            </div>
            <small className="field-help" aria-live="polite">
              {modelsError ? (
                `Không tải được model: ${modelsError} Bạn vẫn có thể nhập model thủ công.`
              ) : !modelsLoading && options.providerAccountFile && models.length === 0 ? (
                `Account không trả về model phù hợp cho ${meta.generationApi}.`
                ) : provider === "gemini" ? (
                  "Chỉ hiện model dịch đã xác minh. Tải danh sách không gửi prompt hoặc transcript."
              ) : (
                "Models API chỉ cho biết model account nhìn thấy; hỗ trợ Responses sẽ được xác nhận khi chạy."
              )}
            </small>
          </label>
        </div>

      <label className="translation-consent" htmlFor="translation-consent">
        <input
          id="translation-consent"
          type="checkbox"
          checked={options.translationConsent}
          onChange={(event) =>
            setOptions({ ...options, translationConsent: event.target.checked })
          }
          disabled={
            queueRunning || !options.providerAccountFile || !options.providerModel.trim()
          }
        />
        <span>
          <strong>Cho phép gửi transcript text tới {meta.name} cho batch này</strong>
          <small>
            {selectedAccount && isOfficialEndpoint(provider, selectedAccount.baseUrl) ? (
              provider === "openai" ? (
                <>
                  Request dùng <code>store:false</code>. Theo policy mặc định của OpenAI,
                  prompt và response vẫn có thể nằm trong abuse-monitoring logs tối đa 30 ngày.
                </>
              ) : (
                <>
                  Chỉ segment ID và text được gửi tới Gemini Generate Content API; hãy kiểm tra
                  data policy và quota của Google account trước khi xác nhận.
                </>
              )
            ) : selectedAccount ? (
              <>
                Transcript sẽ được gửi tới <code>{selectedAccount.baseUrl}</code>. Hãy kiểm tra
                data policy của gateway này trước khi xác nhận.
              </>
            ) : (
              <>Chọn account trước khi xác nhận gửi transcript.</>
            )}
          </small>
        </span>
      </label>
    </div>
  );
}
