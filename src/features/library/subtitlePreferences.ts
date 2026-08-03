export const SUBTITLE_PREFERENCES_STORAGE_KEY = "whispersub:subtitle-preferences";
export const SUBTITLE_FONT_SIZE_MIN = 12;
export const SUBTITLE_FONT_SIZE_MAX = 48;

export const DEFAULT_SUBTITLE_PREFERENCES = {
  fontSize: 14,
  color: "#ffffff",
} as const;

interface ReadableStorage {
  getItem(key: string): string | null;
}

interface WritableStorage {
  setItem(key: string, value: string): void;
}

export type SubtitlePreferences = {
  fontSize: number;
  color: string;
};

export function normalizeSubtitleFontSize(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_SUBTITLE_PREFERENCES.fontSize;
  return Math.min(SUBTITLE_FONT_SIZE_MAX, Math.max(SUBTITLE_FONT_SIZE_MIN, Math.round(value)));
}

export function adjustSubtitleFontSize(value: number, direction: -1 | 1) {
  return normalizeSubtitleFontSize(value + direction * 2);
}

function clampFontSize(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SUBTITLE_PREFERENCES.fontSize;
  }
  return normalizeSubtitleFontSize(value);
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function readSubtitlePreferences(storage?: ReadableStorage): SubtitlePreferences {
  if (!storage) return { ...DEFAULT_SUBTITLE_PREFERENCES };

  try {
    const raw = storage.getItem(SUBTITLE_PREFERENCES_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SUBTITLE_PREFERENCES };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SUBTITLE_PREFERENCES };
    const value = parsed as { fontSize?: unknown; color?: unknown };
    return {
      fontSize: clampFontSize(value.fontSize),
      color: isHexColor(value.color) ? value.color : DEFAULT_SUBTITLE_PREFERENCES.color,
    };
  } catch {
    return { ...DEFAULT_SUBTITLE_PREFERENCES };
  }
}

export function writeSubtitlePreferences(
  preferences: SubtitlePreferences,
  storage?: WritableStorage,
): void {
  if (!storage) return;
  try {
    storage.setItem(SUBTITLE_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // A UI preference must not block the library when storage is unavailable.
  }
}
