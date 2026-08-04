import type { JobOptions } from "../../lib/types";

export function applyYoutubeOutputDefault(
  options: JobOptions,
  preferredDirectory: string | null,
): JobOptions | null {
  const directory = options.outputDirectory?.trim() || preferredDirectory?.trim();
  if (!directory) return null;

  return {
    ...options,
    outputLocationMode: "custom_directory",
    outputDirectory: directory,
  };
}
