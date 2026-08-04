import { useEffect, useMemo, useReducer, useRef, useState } from "react";

import {
  deleteYoutubeLibraryItem,
  getYoutubeLibraryItem,
  listYoutubeLibrary,
} from "../../lib/tauri";
import type { YoutubeLibraryDetail, YoutubeLibrarySummary } from "../../lib/types";
import {
  activeSegment,
  exportLabel,
  PLAYER_ORIGIN,
  playerCommand,
} from "./libraryPresentation";
import {
  canDeleteLibraryItem,
  initialLibraryRequestState,
  initialLibrarySelectionState,
  isDeleteConfirmationForSelection,
  libraryRequestReducer,
  librarySelectionReducer,
  loadLibraryList,
} from "./libraryRequestState";
import {
  adjustSubtitleFontSize,
  DEFAULT_SUBTITLE_PREFERENCES,
  normalizeSubtitleFontSize,
  readSubtitlePreferences,
  SUBTITLE_FONT_SIZE_MAX,
  SUBTITLE_FONT_SIZE_MIN,
  writeSubtitlePreferences,
  type SubtitlePreferences,
} from "./subtitlePreferences";

const SUBTITLE_COLOR_PRESETS = ["#ffffff", "#ffe082", "#9fffcf"];

function getSubtitlePreferenceStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function LibraryPage() {
  const [items, setItems] = useState<YoutubeLibrarySummary[] | null>(null);
  const [selectionState, dispatchSelection] = useReducer(
    librarySelectionReducer,
    initialLibrarySelectionState,
  );
  const [detail, setDetail] = useState<YoutubeLibraryDetail | null>(null);
  const [requestState, dispatchRequest] = useReducer(
    libraryRequestReducer,
    initialLibraryRequestState,
  );
  const [playerWarning, setPlayerWarning] = useState<string | null>(null);
  const [versionIndex, setVersionIndex] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [subtitlePreferences, setSubtitlePreferences] = useState<SubtitlePreferences>(() =>
    readSubtitlePreferences(getSubtitlePreferenceStorage()),
  );
  const playerRef = useRef<HTMLIFrameElement>(null);
  const itemsRef = useRef<YoutubeLibrarySummary[] | null>(null);
  itemsRef.current = items;
  const selected = selectionState.selected;

  const reload = async (preferred?: string | null) => {
    await loadLibraryList({
      load: listYoutubeLibrary,
      dispatch: dispatchRequest,
      setItems,
      setSelected: (videoId) => dispatchSelection({ type: "selection_changed", videoId }),
      preferred,
    });
  };

  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    writeSubtitlePreferences(subtitlePreferences, getSubtitlePreferenceStorage());
  }, [subtitlePreferences]);

  useEffect(() => {
    let stale = false;
    if (!selected) {
      setDetail(null);
      return;
    }
    setDetail(null);
    setPlayerWarning(null);
    dispatchRequest({ type: "detail_started" });
    void getYoutubeLibraryItem(selected)
      .then((value) => {
        if (!stale) {
          setDetail(value);
          setVersionIndex(0);
        }
      })
      .catch((cause) => {
        if (!stale) {
          dispatchRequest({ type: "detail_failed", error: String(cause) });
        }
      });
    return () => {
      stale = true;
    };
  }, [requestState.detailRequestVersion, selected]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== PLAYER_ORIGIN ||
        event.source !== playerRef.current?.contentWindow
      ) {
        return;
      }
      try {
        const payload = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (typeof payload?.info?.currentTime === "number") {
          dispatchSelection({ type: "time_changed", time: payload.info.currentTime });
        }
      } catch {
        // Ignore unrelated postMessage payloads.
      }
    };
    const poll = () => playerRef.current?.contentWindow?.postMessage(
      playerCommand("getCurrentTime"),
      PLAYER_ORIGIN,
    );
    window.addEventListener("message", receive);
    const id = window.setInterval(poll, 500);
    return () => {
      window.removeEventListener("message", receive);
      window.clearInterval(id);
    };
  }, [detail?.videoId]);

  const version = detail?.versions[versionIndex];
  const subtitle = useMemo(
    () => version && activeSegment(version.segments, selectionState.time),
    [selectionState.time, version],
  );
  const seek = (at: number) => {
    dispatchSelection({ type: "time_changed", time: at });
    playerRef.current?.contentWindow?.postMessage(playerCommand("seekTo", at), PLAYER_ORIGIN);
  };
  const remove = async (videoId: string) => {
    if (
      !canDeleteLibraryItem(
        selectionState.confirmingVideoId,
        selectionState.selected,
        detail?.videoId ?? null,
        videoId,
      )
    ) {
      return;
    }
    setDeleting(true);
    try {
      await deleteYoutubeLibraryItem(videoId);
      const currentItems = itemsRef.current ?? [];
      const fallbackVideoId = currentItems.find((item) => item.videoId !== videoId)?.videoId ?? null;
      setItems((current) => current?.filter((item) => item.videoId !== videoId) ?? []);
      dispatchSelection({
        type: "delete_succeeded",
        videoId,
        fallbackVideoId,
      });
    } catch (cause) {
      dispatchSelection({ type: "delete_failed", error: String(cause) });
    } finally {
      setDeleting(false);
    }
  };

  if (items === null) return <LibraryState busy text="Đang tải phụ đề đã lưu…" />;
  if (requestState.listError && !detail) {
    return <LibraryState text={requestState.listError} retry={() => void reload()} />;
  }
  if (requestState.detailError && !detail) {
    return (
      <LibraryState
        text={requestState.detailError}
        retry={() => dispatchRequest({ type: "retry_detail" })}
      />
    );
  }
  if (!items.length) return <LibraryState text="Chưa có video YouTube nào." />;

  return (
    <section className="library-page">
      <header className="library-heading">
        <div>
          <h1>Thư viện</h1>
          <p>Phụ đề tiếng Việt đã lưu trên máy. Xóa mục không xóa cache hoặc file xuất.</p>
        </div>
        <span>{items.length} video</span>
      </header>
      <div className={isFocusMode ? "library-layout is-focus" : "library-layout"}>
        <aside className="library-list" aria-label="Video đã lưu">
          {items.map((item) => (
            <button
              key={item.videoId}
              className={item.videoId === selected ? "library-item is-selected" : "library-item"}
              aria-pressed={item.videoId === selected}
                onClick={() =>
                  dispatchSelection({ type: "selection_changed", videoId: item.videoId })
                }
            >
              <strong>{item.displayTitle}</strong>
              <small>{item.versionCount} phiên bản</small>
            </button>
          ))}
        </aside>
        <article className="library-detail">
          {!detail || !version ? (
            <p className="library-state">Đang mở video…</p>
          ) : (
            <LibraryDetail
              detail={detail}
              version={version}
              versionIndex={versionIndex}
              subtitleId={subtitle?.id}
              playerRef={playerRef}
              isFocusMode={isFocusMode}
              subtitlePreferences={subtitlePreferences}
              playerWarning={playerWarning}
              confirming={isDeleteConfirmationForSelection(
                selectionState.confirmingVideoId,
                detail.videoId,
              )}
              deleting={deleting}
              error={selectionState.actionError}
              onVersion={setVersionIndex}
              onFocusMode={() => setIsFocusMode((value) => !value)}
              onSubtitleFontSize={(fontSize) =>
                setSubtitlePreferences((current) => ({ ...current, fontSize }))
              }
              onSubtitleColor={(color) =>
                setSubtitlePreferences((current) => ({ ...current, color }))
              }
              onSubtitleReset={() =>
                setSubtitlePreferences({ ...DEFAULT_SUBTITLE_PREFERENCES })
              }
              onSeek={seek}
              onConfirm={() =>
                dispatchSelection({ type: "confirm_delete", videoId: detail.videoId })
              }
              onCancel={() => dispatchSelection({ type: "cancel_delete" })}
              onRemove={() => void remove(detail.videoId)}
              onPlayerWarning={setPlayerWarning}
            />
          )}
        </article>
      </div>
    </section>
  );
}

interface LibraryStateProps {
  busy?: boolean;
  text: string;
  retry?: () => void;
}

function LibraryState({ busy, text, retry }: LibraryStateProps) {
  return (
    <section className="library-page" aria-busy={busy}>
      <h1>Thư viện</h1>
      <p className="library-state" role={retry ? "alert" : busy ? "status" : undefined}>
        {text}
      </p>
      {retry && (
        <button className="secondary-button" onClick={retry}>
          Thử lại
        </button>
      )}
    </section>
  );
}

interface LibraryDetailProps {
  detail: YoutubeLibraryDetail;
  version: YoutubeLibraryDetail["versions"][number];
  versionIndex: number;
  subtitleId?: number;
  playerRef: React.RefObject<HTMLIFrameElement | null>;
  isFocusMode: boolean;
  subtitlePreferences: SubtitlePreferences;
  playerWarning: string | null;
  confirming: boolean;
  deleting: boolean;
  error: string | null;
  onVersion: (value: number) => void;
  onFocusMode: () => void;
  onSubtitleFontSize: (fontSize: number) => void;
  onSubtitleColor: (color: string) => void;
  onSubtitleReset: () => void;
  onSeek: (at: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onRemove: () => void;
  onPlayerWarning: (value: string) => void;
}

function LibraryDetail(props: LibraryDetailProps) {
  const {
    detail,
    version,
    versionIndex,
    subtitleId,
    playerRef,
    isFocusMode,
    subtitlePreferences,
    playerWarning,
    confirming,
    deleting,
    error,
    onVersion,
    onFocusMode,
    onSubtitleFontSize,
    onSubtitleColor,
    onSubtitleReset,
    onSeek,
    onConfirm,
    onCancel,
    onRemove,
    onPlayerWarning,
  } = props;

  return (
    <>
      <div className="library-detail-header">
        <div className="library-detail-copy">
          <h2>{detail.displayTitle}</h2>
          <p>Phụ đề tiếng Việt lấy từ dữ liệu local.</p>
        </div>
        <div className="library-detail-actions">
          {detail.versions.length > 1 && (
            <label className="library-version-control">
              <span>Phiên bản</span>
              <select
                value={versionIndex}
                onChange={(event) => onVersion(Number(event.target.value))}
              >
                {detail.versions.map((item, index) => (
                  <option key={item.recipeFingerprint} value={index}>
                    {new Date(item.createdAt).toLocaleString("vi-VN")}
                  </option>
                ))}
              </select>
            </label>
          )}
          <details className="subtitle-controls">
            <summary>Phụ đề local</summary>
            <div className="subtitle-controls-panel">
              <div className="subtitle-controls-heading">
                <div>
                  <strong>Tùy chỉnh phụ đề</strong>
                  <span>Chỉ áp dụng cho lớp phụ đề của WhisperSub.</span>
                </div>
                <button type="button" onClick={onSubtitleReset}>
                  Đặt lại
                </button>
              </div>
              <div className="subtitle-setting-row">
                <span>Cỡ chữ</span>
                <div className="subtitle-stepper">
                  <button
                    type="button"
                    aria-label="Giảm cỡ chữ phụ đề"
                    onClick={() =>
                      onSubtitleFontSize(adjustSubtitleFontSize(subtitlePreferences.fontSize, -1))
                    }
                  >
                    −
                  </button>
                  <label>
                    <input
                      type="number"
                      min={SUBTITLE_FONT_SIZE_MIN}
                      max={SUBTITLE_FONT_SIZE_MAX}
                      step={1}
                      value={subtitlePreferences.fontSize}
                      onChange={(event) =>
                        onSubtitleFontSize(normalizeSubtitleFontSize(Number(event.target.value)))
                      }
                      aria-label="Cỡ chữ phụ đề local"
                    />
                    <span>px</span>
                  </label>
                  <button
                    type="button"
                    aria-label="Tăng cỡ chữ phụ đề"
                    onClick={() =>
                      onSubtitleFontSize(adjustSubtitleFontSize(subtitlePreferences.fontSize, 1))
                    }
                  >
                    +
                  </button>
                </div>
              </div>
              <fieldset className="subtitle-color-settings">
                <legend>Màu chữ</legend>
                <div className="subtitle-color-options">
                  {SUBTITLE_COLOR_PRESETS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className="subtitle-color-swatch"
                      style={{ backgroundColor: color }}
                      aria-label={`Chọn màu phụ đề ${color}`}
                      aria-pressed={subtitlePreferences.color === color}
                      onClick={() => onSubtitleColor(color)}
                    />
                  ))}
                  <label className="subtitle-custom-color">
                    <input
                      type="color"
                      value={subtitlePreferences.color}
                      onChange={(event) => onSubtitleColor(event.target.value)}
                      aria-label="Chọn màu phụ đề tùy chỉnh"
                    />
                    <span>Tùy chọn</span>
                  </label>
                </div>
              </fieldset>
              <div
                className="subtitle-preview"
                style={
                  {
                    "--subtitle-font-size": `${subtitlePreferences.fontSize}px`,
                    "--subtitle-color": subtitlePreferences.color,
                  } as React.CSSProperties
                }
              >
                Đây là phụ đề mẫu
              </div>
            </div>
          </details>
          <button
            className="secondary-button"
            type="button"
            aria-pressed={isFocusMode}
            onClick={onFocusMode}
          >
            {isFocusMode ? "Hiện danh sách" : "Mở rộng"}
          </button>
        </div>
      </div>
      <div className="library-player">
        <iframe
          ref={playerRef}
          title={`YouTube: ${detail.displayTitle}`}
          src={`${PLAYER_ORIGIN}/embed/${detail.videoId}?enablejsapi=1`}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; fullscreen; gyroscope; picture-in-picture"
          allowFullScreen
          onLoad={() =>
            playerRef.current?.contentWindow?.postMessage(
              JSON.stringify({ event: "listening", id: detail.videoId }),
              PLAYER_ORIGIN,
            )
          }
          onError={() =>
            onPlayerWarning("Không thể tải player; transcript local vẫn dùng được.")
          }
        />
        <div
          className="subtitle-overlay"
          aria-live="polite"
          style={
            {
              "--subtitle-font-size": `${subtitlePreferences.fontSize}px`,
              "--subtitle-color": subtitlePreferences.color,
            } as React.CSSProperties
          }
        >
          {version.segments.find((segment) => segment.id === subtitleId)?.text ?? ""}
        </div>
      </div>
      {playerWarning && (
        <p role="status" className="library-player-help">
          {playerWarning}
        </p>
      )}
      <div
        className="library-transcript"
        tabIndex={0}
        aria-label="Transcript tiếng Việt"
      >
        {version.segments.map((segment) => (
          <button
            key={segment.id}
            className={subtitleId === segment.id ? "is-active" : ""}
            onClick={() => onSeek(segment.start)}
          >
            <time>{segment.start.toFixed(0)}s</time>
            {segment.text}
          </button>
        ))}
      </div>
      {version.exports.length === 0 ? (
        <p className="library-exports">
          Không có đường dẫn file export được ghi nhận.
        </p>
      ) : (
        <ul className="library-exports">
          {version.exports.map((value) => (
            <li key={value.path} data-available={value.available}>
              {exportLabel(value)}
            </li>
          ))}
        </ul>
      )}
      <div className="library-delete">
        {confirming ? (
          <>
            <p>Cache và file export không bị xóa.</p>
            <button className="danger-button" disabled={deleting} onClick={onRemove}>
              Xác nhận xóa
            </button>
            <button className="secondary-button" disabled={deleting} onClick={onCancel}>
              Hủy
            </button>
          </>
        ) : (
          <button className="danger-button" disabled={deleting} onClick={onConfirm}>
            Xóa khỏi Thư viện
          </button>
        )}
        <span role="status">{deleting ? "Đang xóa…" : error ?? ""}</span>
      </div>
    </>
  );
}
