import { type KeyboardEvent } from "react";
import { routeHash } from "../navigation/hashRoute";
import type { Provider } from "../../lib/types";
import { ProviderAccounts } from "./ProviderAccounts";

interface ApiKeysPageProps {
  provider: Provider;
  disabled: boolean;
}

const providers: Array<{ id: Provider; name: string; monogram: string }> = [
  { id: "openai", name: "OpenAI", monogram: "O" },
  { id: "gemini", name: "Gemini", monogram: "G" },
];

export function ApiKeysPage({ provider, disabled }: ApiKeysPageProps) {
  function selectProvider(nextProvider: Provider, focus = false) {
    window.location.hash = routeHash({ page: "apiKeys", provider: nextProvider });
    if (focus) {
      window.requestAnimationFrame(() => {
        document.getElementById(`${nextProvider}-provider-tab`)?.focus();
      });
    }
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const currentIndex = providers.findIndex((candidate) => candidate.id === provider);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % providers.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + providers.length) % providers.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = providers.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    selectProvider(providers[nextIndex].id, true);
  }

  return (
    <section className="api-keys-page" aria-labelledby="api-keys-heading">
      <header className="api-keys-intro">
        <div>
          <p className="eyebrow">Provider credentials</p>
            <h1 id="api-keys-heading">API Keys</h1>
          <p>Thêm, chỉnh sửa và chọn account riêng cho từng dịch vụ.</p>
        </div>
          <span className="api-readiness">Dùng được cho dịch transcript</span>
      </header>

      <aside className="storage-notice" aria-labelledby="storage-notice-heading">
        <span className="storage-notice-icon" aria-hidden="true">i</span>
        <div>
          <strong id="storage-notice-heading">Lưu cục bộ dạng plaintext</strong>
          <p>
            API key được lưu dưới dạng JSON không mã hóa tại <code>~/.whispersub/accounts</code>.
              Media luôn được xử lý cục bộ; chỉ transcript text được gửi khi bạn chọn provider và
              xác nhận consent cho batch.
          </p>
        </div>
      </aside>

      <div className="provider-tabs" role="tablist" aria-label="Chọn API provider">
        {providers.map((candidate) => {
          const selected = candidate.id === provider;
          return (
            <button
              key={candidate.id}
              type="button"
              id={`${candidate.id}-provider-tab`}
              className="provider-tab"
              role="tab"
              aria-selected={selected}
              aria-controls={`${candidate.id}-provider-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => selectProvider(candidate.id)}
              onKeyDown={handleTabKeyDown}
            >
              <span className={`provider-monogram ${candidate.id}`} aria-hidden="true">
                {candidate.monogram}
              </span>
              {candidate.name}
            </button>
          );
        })}
      </div>

      <div
        id={`${provider}-provider-panel`}
        role="tabpanel"
        aria-labelledby={`${provider}-provider-tab`}
        tabIndex={0}
      >
        <ProviderAccounts provider={provider} disabled={disabled} />
      </div>
    </section>
  );
}
