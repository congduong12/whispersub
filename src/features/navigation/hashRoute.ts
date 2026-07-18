import type { Provider } from "../../lib/types";

export type AppRoute =
  | { page: "dashboard" }
  | { page: "apiKeys"; provider: Provider };

export function parseHashRoute(hash: string): AppRoute {
  const normalized = hash.replace(/^#/, "").replace(/^\//, "");
  if (normalized === "api-keys/gemini") {
    return { page: "apiKeys", provider: "gemini" };
  }
  if (normalized === "api-keys" || normalized === "api-keys/openai") {
    return { page: "apiKeys", provider: "openai" };
  }
  return { page: "dashboard" };
}

export function routeHash(route: AppRoute): string {
  return route.page === "dashboard"
    ? "#dashboard"
    : `#api-keys/${route.provider}`;
}
