import { describe, expect, it } from "vitest";
import {
  activeSegment,
  exportLabel,
  playerCommand,
} from "./libraryPresentation";
import {
  initialLibraryRequestState,
  initialLibrarySelectionState,
  canDeleteLibraryItem,
  isDeleteConfirmationForSelection,
  loadLibraryList,
  libraryRequestReducer,
  librarySelectionReducer,
} from "./libraryRequestState";

describe("library helpers", () => {
  const segments = [
    { id: 0, start: 1, end: 2, text: "A" },
    { id: 1, start: 2, end: 3, text: "B" },
  ];

  it("uses half-open subtitle boundaries", () => {
    expect(activeSegment(segments, 0)).toBeUndefined();
    expect(activeSegment(segments, 2)?.id).toBe(1);
    expect(activeSegment(segments, 3)).toBeUndefined();
  });

  it("labels export availability", () => {
    expect(exportLabel({ path: "/tmp/a.srt", available: false })).toContain(
      "Không tìm thấy",
    );
  });

  it("builds YouTube postMessage commands", () => {
    expect(JSON.parse(playerCommand("getCurrentTime"))).toMatchObject({
      event: "command",
      func: "getCurrentTime",
      args: [],
    });
    expect(JSON.parse(playerCommand("seekTo", 42))).toMatchObject({
      func: "seekTo",
      args: [42, true],
    });
  });

  it("retries the same selected detail without reloading the list", () => {
    const failed = libraryRequestReducer(initialLibraryRequestState, {
      type: "detail_failed",
      error: "detail unavailable",
    });
    const retrying = libraryRequestReducer(failed, { type: "retry_detail" });

    expect(retrying.detailRequestVersion).toBe(1);
    expect(retrying.detailError).toBeNull();
    expect(retrying.listError).toBeNull();
  });

  it("keeps list and detail errors independent", () => {
    const listFailed = libraryRequestReducer(initialLibraryRequestState, {
      type: "list_failed",
      error: "list unavailable",
    });
    const detailStarted = libraryRequestReducer(listFailed, { type: "detail_started" });

    expect(detailStarted.listError).toBe("list unavailable");
    expect(detailStarted.detailError).toBeNull();
  });

  it("binds deletion confirmation to its original video and clears transient state on selection", () => {
    const staleTransientState = librarySelectionReducer(
      librarySelectionReducer(initialLibrarySelectionState, {
        type: "time_changed",
        time: 42,
      }),
      { type: "delete_failed", error: "delete unavailable" },
    );
    const confirmingA = librarySelectionReducer(staleTransientState, {
      type: "confirm_delete",
      videoId: "video-a",
    });
    const selectedB = librarySelectionReducer(confirmingA, {
      type: "selection_changed",
      videoId: "video-b",
    });

    expect(isDeleteConfirmationForSelection(confirmingA.confirmingVideoId, "video-a")).toBe(true);
    expect(isDeleteConfirmationForSelection(confirmingA.confirmingVideoId, "video-b")).toBe(false);
    expect(selectedB).toMatchObject({
      selected: "video-b",
      confirmingVideoId: null,
      actionError: null,
      time: 0,
    });
    expect(canDeleteLibraryItem("video-a", "video-a", "video-a", "video-a")).toBe(true);
    expect(canDeleteLibraryItem("video-a", "video-b", "video-b", "video-b")).toBe(false);
  });

  it("preserves a newer selection when an earlier pending delete succeeds", () => {
    const selectedA = librarySelectionReducer(initialLibrarySelectionState, {
      type: "selection_changed",
      videoId: "video-a",
    });
    const selectedCWhileDeletingA = librarySelectionReducer(selectedA, {
      type: "selection_changed",
      videoId: "video-c",
    });

    const completed = librarySelectionReducer(selectedCWhileDeletingA, {
      type: "delete_succeeded",
      videoId: "video-a",
      fallbackVideoId: "video-b",
    });
    const selectedAFallsBack = librarySelectionReducer(selectedA, {
      type: "delete_succeeded",
      videoId: "video-a",
      fallbackVideoId: "video-b",
    });

    expect(completed.selected).toBe("video-c");
    expect(selectedAFallsBack.selected).toBe("video-b");
  });

  it("catches list retry failures and records the list error instead of rejecting", async () => {
    const actions: unknown[] = [];
    const items: unknown[] = [];
    const selections: Array<string | null> = [];

    await expect(
      loadLibraryList({
        load: async () => {
          throw new Error("library unavailable");
        },
        dispatch: (action) => actions.push(action),
        setItems: (value) => items.push(value),
        setSelected: (value) => selections.push(value),
      }),
    ).resolves.toBeUndefined();

    expect(actions).toEqual([
      { type: "list_started" },
      { type: "list_failed", error: "Error: library unavailable" },
    ]);
    expect(items).toEqual([[]]);
    expect(selections).toEqual([]);
  });
});
