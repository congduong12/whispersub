import { describe, expect, it, vi } from "vitest";
import {
  readSidebarCollapsed,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  writeSidebarCollapsed,
} from "./sidebarPreference";

describe("WS-016 sidebar preference", () => {
  it("defaults to an expanded sidebar when storage is missing or invalid", () => {
    expect(readSidebarCollapsed()).toBe(false);
    expect(readSidebarCollapsed({ getItem: () => null })).toBe(false);
    expect(readSidebarCollapsed({ getItem: () => "false" })).toBe(false);
    expect(readSidebarCollapsed({ getItem: () => "unexpected" })).toBe(false);
  });

  it("restores only an explicitly collapsed preference", () => {
    expect(readSidebarCollapsed({ getItem: () => "true" })).toBe(true);
  });

  it("ignores unavailable storage instead of blocking app startup", () => {
    expect(
      readSidebarCollapsed({
        getItem: () => {
          throw new Error("storage unavailable");
        },
      }),
    ).toBe(false);

    expect(() =>
      writeSidebarCollapsed(true, {
        setItem: () => {
          throw new Error("storage unavailable");
        },
      }),
    ).not.toThrow();
  });

  it("writes the boolean preference under a stable local key", () => {
    const setItem = vi.fn();

    writeSidebarCollapsed(true, { setItem });
    writeSidebarCollapsed(false, { setItem });

    expect(setItem).toHaveBeenNthCalledWith(1, SIDEBAR_COLLAPSED_STORAGE_KEY, "true");
    expect(setItem).toHaveBeenNthCalledWith(2, SIDEBAR_COLLAPSED_STORAGE_KEY, "false");
  });
});
