export const SIDEBAR_COLLAPSED_STORAGE_KEY = "whispersub:sidebar-collapsed";

interface ReadablePreferenceStorage {
  getItem(key: string): string | null;
}

interface WritablePreferenceStorage {
  setItem(key: string, value: string): void;
}

export function readSidebarCollapsed(storage?: ReadablePreferenceStorage): boolean {
  if (!storage) return false;

  try {
    return storage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(
  collapsed: boolean,
  storage?: WritablePreferenceStorage,
): void {
  if (!storage) return;

  try {
    storage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // A UI preference must not prevent the app from starting in restricted storage contexts.
  }
}
