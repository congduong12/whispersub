import type { Provider } from "../../lib/types";

export type AppRoute =
  | { page: "dashboard" }
  | { page: "library" }
  | { page: "apiKeys"; provider: Provider };

export function parseHashRoute(hash: string): AppRoute {
  const normalized = hash.replace(/^#/, "").replace(/^\//, "");
  if (normalized === "api-keys/gemini") {
    return { page: "apiKeys", provider: "gemini" };
  }
    if (normalized === "api-keys" || normalized === "api-keys/openai") {
    return { page: "apiKeys", provider: "openai" };
    }
    if (normalized === "library") return { page: "library" };
  return { page: "dashboard" };
}

export function routeHash(route: AppRoute): string {
  return route.page === "dashboard" ? "#dashboard" : route.page === "library" ? "#library" : `#api-keys/${route.provider}`;
}
