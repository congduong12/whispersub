import { describe, expect, it } from "vitest";
import type { JobOptions } from "../../lib/types";
import { applyYoutubeOutputDefault } from "./youtubeOutput";

const options: JobOptions = {
  model: "small",
  sourceLanguage: "vi",
  targetLanguage: "none",
  translationProvider: "gemini",
  providerAccountFile: null,
  providerModel: "",
  translationConsent: false,
  device: "auto",
  includeVtt: false,
  outputLocationMode: "same_as_input",
  outputDirectory: null,
};

describe("applyYoutubeOutputDefault", () => {
  it("selects the system-resolved YouTube directory", () => {
    expect(
      applyYoutubeOutputDefault(
        options,
        "/Users/test/Documents/WhisperSub/Subtitles",
      ),
    ).toMatchObject({
      outputLocationMode: "custom_directory",
      outputDirectory: "/Users/test/Documents/WhisperSub/Subtitles",
    });
  });

  it("keeps an already remembered custom directory", () => {
    expect(
      applyYoutubeOutputDefault(
        {
          ...options,
          outputLocationMode: "custom_directory",
          outputDirectory: "/Volumes/Learning/Subtitles",
        },
        "/Users/test/Documents/WhisperSub/Subtitles",
      ),
    ).toMatchObject({
      outputLocationMode: "custom_directory",
      outputDirectory: "/Volumes/Learning/Subtitles",
    });
  });

  it("reports that storage is not ready when no directory is available", () => {
    expect(applyYoutubeOutputDefault(options, null)).toBeNull();
  });
});
