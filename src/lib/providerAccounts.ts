import type { Provider } from "./types";

export const DEFAULT_PROVIDER_BASE_URLS: Record<Provider, string> = {
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com",
};

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  const parts = normalized.split(".");
  return parts.length === 4
    && parts.every((part) => /^\d+$/.test(part))
    && Number(parts[0]) === 127
    && parts.every((part) => Number(part) >= 0 && Number(part) <= 255);
}

export function normalizeProviderBaseUrl(provider: Provider, input: string): string {
  const candidate = input.trim() || DEFAULT_PROVIDER_BASE_URLS[provider];
  if (candidate.length > 2_048) {
    throw new Error("validation: Base URL không được dài hơn 2048 ký tự.");
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("validation: Base URL không hợp lệ.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("validation: Base URL không được chứa thông tin đăng nhập.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("validation: Base URL không được chứa query hoặc fragment.");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) {
    throw new Error(
      "validation: Base URL phải dùng HTTPS. HTTP chỉ được phép cho endpoint loopback local.",
    );
  }

  return parsed.toString().replace(/\/+$/, "");
}
