export interface LibraryRequestState {
  listError: string | null;
  detailError: string | null;
  detailRequestVersion: number;
}

export type LibraryRequestAction =
  | { type: "list_started" }
  | { type: "list_failed"; error: string }
  | { type: "detail_started" }
  | { type: "detail_failed"; error: string }
  | { type: "retry_detail" };

export const initialLibraryRequestState: LibraryRequestState = {
  listError: null,
  detailError: null,
  detailRequestVersion: 0,
};

export interface LibrarySelectionState {
  selected: string | null;
  confirmingVideoId: string | null;
  actionError: string | null;
  time: number;
}

export type LibrarySelectionAction =
  | { type: "selection_changed"; videoId: string | null }
  | { type: "confirm_delete"; videoId: string }
  | { type: "cancel_delete" }
  | { type: "delete_succeeded"; videoId: string; fallbackVideoId: string | null }
  | { type: "delete_failed"; error: string }
  | { type: "time_changed"; time: number };

export const initialLibrarySelectionState: LibrarySelectionState = {
  selected: null,
  confirmingVideoId: null,
  actionError: null,
  time: 0,
};

export function libraryRequestReducer(
  state: LibraryRequestState,
  action: LibraryRequestAction,
): LibraryRequestState {
  switch (action.type) {
    case "list_started":
      return { ...state, listError: null };
    case "list_failed":
      return { ...state, listError: action.error };
    case "detail_started":
      return { ...state, detailError: null };
    case "detail_failed":
      return { ...state, detailError: action.error };
    case "retry_detail":
      return {
        ...state,
        detailError: null,
        detailRequestVersion: state.detailRequestVersion + 1,
      };
  }
}

export function librarySelectionReducer(
  state: LibrarySelectionState,
  action: LibrarySelectionAction,
): LibrarySelectionState {
  switch (action.type) {
    case "selection_changed":
      return {
        ...state,
        selected: action.videoId,
        confirmingVideoId: null,
        actionError: null,
        time: 0,
      };
    case "confirm_delete":
      return { ...state, confirmingVideoId: action.videoId, actionError: null };
    case "cancel_delete":
      return { ...state, confirmingVideoId: null };
    case "delete_succeeded":
      if (state.selected !== action.videoId) return state;
      return {
        ...state,
        selected: action.fallbackVideoId,
        confirmingVideoId: null,
        actionError: null,
        time: 0,
      };
    case "delete_failed":
      return { ...state, actionError: action.error };
    case "time_changed":
      return { ...state, time: action.time };
  }
}

export function isDeleteConfirmationForSelection(
  confirmingVideoId: string | null,
  selectedVideoId: string,
): boolean {
  return confirmingVideoId === selectedVideoId;
}

export function canDeleteLibraryItem(
  confirmingVideoId: string | null,
  selectedVideoId: string | null,
  detailVideoId: string | null,
  requestedVideoId: string,
): boolean {
  return (
    confirmingVideoId === requestedVideoId &&
    selectedVideoId === requestedVideoId &&
    detailVideoId === requestedVideoId
  );
}

interface LoadLibraryListOptions<T extends { videoId: string }> {
  load: () => Promise<T[]>;
  dispatch: (action: LibraryRequestAction) => void;
  setItems: (items: T[]) => void;
  setSelected: (videoId: string | null) => void;
  preferred?: string | null;
}

export async function loadLibraryList<T extends { videoId: string }>({
  load,
  dispatch,
  setItems,
  setSelected,
  preferred,
}: LoadLibraryListOptions<T>): Promise<void> {
  dispatch({ type: "list_started" });
  try {
    const items = await load();
    setItems(items);
    setSelected(preferred ?? items[0]?.videoId ?? null);
  } catch (cause) {
    dispatch({ type: "list_failed", error: String(cause) });
    setItems([]);
  }
}
