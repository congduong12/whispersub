import { describe, expect, it, vi } from "vitest";
import {
  adjustSubtitleFontSize,
  DEFAULT_SUBTITLE_PREFERENCES,
  readSubtitlePreferences,
  SUBTITLE_PREFERENCES_STORAGE_KEY,
  writeSubtitlePreferences,
} from "./subtitlePreferences";

describe("subtitle preferences", () => {
  it("uses safe defaults when storage is missing or malformed", () => {
    expect(readSubtitlePreferences()).toEqual(DEFAULT_SUBTITLE_PREFERENCES);
    expect(readSubtitlePreferences({ getItem: () => "not-json" })).toEqual(
      DEFAULT_SUBTITLE_PREFERENCES,
    );
  });

  it("clamps saved font size and rejects invalid colors", () => {
    expect(
      readSubtitlePreferences({
        getItem: () => JSON.stringify({ fontSize: 80, color: "red" }),
      }),
    ).toEqual({ fontSize: 48, color: DEFAULT_SUBTITLE_PREFERENCES.color });
    expect(
      readSubtitlePreferences({
        getItem: () => JSON.stringify({ fontSize: 48, color: "#00ff00" }),
      }),
    ).toEqual({ fontSize: 48, color: "#00ff00" });
  });

  it("writes preferences under a stable local key", () => {
    const setItem = vi.fn();
    writeSubtitlePreferences({ fontSize: 24, color: "#ff00aa" }, { setItem });
    expect(setItem).toHaveBeenCalledWith(
      SUBTITLE_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ fontSize: 24, color: "#ff00aa" }),
    );
  });

  it("adjusts subtitle size in bounded two-pixel steps", () => {
    expect(adjustSubtitleFontSize(14, 1)).toBe(16);
    expect(adjustSubtitleFontSize(14, -1)).toBe(12);
    expect(adjustSubtitleFontSize(48, 1)).toBe(48);
  });
});
