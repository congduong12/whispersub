import type { SubtitleSegment } from "../../lib/types";
export const PLAYER_ORIGIN = "https://www.youtube-nocookie.com";

export function activeSegment(
  segments: SubtitleSegment[],
  time: number,
) {
  return segments.find((segment) => time >= segment.start && time < segment.end);
}

export function exportLabel(value: {
  path: string;
  available: boolean;
}) {
  return value.available ? `Có sẵn: ${value.path}` : `Không tìm thấy: ${value.path}`;
}

export function playerCommand(
  func: "getCurrentTime" | "seekTo",
  time?: number,
) {
  return JSON.stringify({
    event: "command",
    func,
    args: func === "seekTo" ? [time ?? 0, true] : [],
  });
}
