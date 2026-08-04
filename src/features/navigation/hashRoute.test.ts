import { describe, expect, it } from "vitest";
import { parseHashRoute, routeHash } from "./hashRoute";

describe("WS-007 hash navigation", () => {
  it("defaults unknown and empty locations to Dashboard", () => {
    expect(parseHashRoute("")).toEqual({ page: "dashboard" });
    expect(parseHashRoute("#something-else")).toEqual({ page: "dashboard" });
  });

  it("opens each provider workspace from a stable hash", () => {
    expect(parseHashRoute("#api-keys/openai")).toEqual({
      page: "apiKeys",
      provider: "openai",
    });
    expect(parseHashRoute("#/api-keys/gemini")).toEqual({
      page: "apiKeys",
      provider: "gemini",
    });
  });

  it("keeps Library on a stable hash", () => {
    expect(parseHashRoute("#library")).toEqual({ page: "library" });
    expect(routeHash({ page: "library" })).toBe("#library");
  });

  it("serializes routes for real links and back-forward navigation", () => {
    expect(routeHash({ page: "dashboard" })).toBe("#dashboard");
    expect(routeHash({ page: "apiKeys", provider: "openai" })).toBe(
      "#api-keys/openai",
    );
    expect(routeHash({ page: "apiKeys", provider: "gemini" })).toBe(
      "#api-keys/gemini",
    );
  });
});
