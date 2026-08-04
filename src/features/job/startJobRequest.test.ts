import { describe, expect, it } from "vitest";
import type { JobOptions } from "../../lib/types";
import { buildLocalStartJobRequest } from "./startJobRequest";

const baseOptions: JobOptions = {
  model: "small",
  sourceLanguage: "auto",
  targetLanguage: "none",
  translationProvider: "openai",
  providerAccountFile: null,
  providerModel: "gpt-5.6-luna",
  translationConsent: false,
  device: "auto",
  includeVtt: false,
  outputLocationMode: "same_as_input",
  outputDirectory: null,
};

describe("buildLocalStartJobRequest", () => {
  it("keeps the ready target on the local transcription path", () => {
    expect(
      buildLocalStartJobRequest(
          { jobId: "job_local", source: { kind: "local_file", inputPath: "/video/mixed.mp4" } },
        baseOptions,
      ),
      ).toMatchObject({
        targetLanguage: "none",
        task: "transcribe",
        translationProvider: "none",
        translationMode: "none",
        providerAccountFile: null,
        providerModel: null,
        translationConsent: false,
      });
  });

  it("builds a consented OpenAI translation request", () => {
    expect(
      buildLocalStartJobRequest(
          { jobId: "job_vi", source: { kind: "local_file", inputPath: "/video/lesson.mp4" } },
        {
          ...baseOptions,
          targetLanguage: "vi",
          providerAccountFile: "openai_work_1.json",
          providerModel: "gpt-5.6-luna",
          translationConsent: true,
        },
      ),
    ).toMatchObject({
      targetLanguage: "vi",
      translationProvider: "openai_api",
      translationMode: "technical_context",
      technicalTranslation: true,
      glossary: "software-engineering-default",
      providerAccountFile: "openai_work_1.json",
      providerModel: "gpt-5.6-luna",
      translationConsent: true,
    });
  });

  it("applies one custom output directory to the request", () => {
    expect(
      buildLocalStartJobRequest(
          { jobId: "job_custom_output", source: { kind: "local_file", inputPath: "/video/lesson.mp4" } },
        {
          ...baseOptions,
          outputLocationMode: "custom_directory",
          outputDirectory: "/Users/mac/Movies/Subtitles",
        },
      ),
    ).toMatchObject({
      outputLocationMode: "custom_directory",
      outputDirectory: "/Users/mac/Movies/Subtitles",
    });
  });

  it("blocks a custom output request without a directory", () => {
    expect(() =>
      buildLocalStartJobRequest(
          { jobId: "job_missing_output", source: { kind: "local_file", inputPath: "/video/lesson.mp4" } },
        {
          ...baseOptions,
          outputLocationMode: "custom_directory",
          outputDirectory: null,
        },
      ),
    ).toThrow("Chọn thư mục lưu cho batch");
  });

  it("builds a consented Gemini translation request", () => {
    expect(
      buildLocalStartJobRequest(
          { jobId: "job_gemini", source: { kind: "local_file", inputPath: "/video/lesson.mp4" } },
        {
          ...baseOptions,
          targetLanguage: "vi",
          translationProvider: "gemini",
          providerAccountFile: "gemini_personal_1.json",
          providerModel: "gemini-3.5-flash",
          translationConsent: true,
        },
      ),
    ).toMatchObject({
      translationProvider: "gemini_api",
      providerAccountFile: "gemini_personal_1.json",
      providerModel: "gemini-3.5-flash",
    });
  });

  it("blocks translation when consent is missing", () => {
    expect(() =>
      buildLocalStartJobRequest(
          { jobId: "job_blocked", source: { kind: "local_file", inputPath: "/video/mixed.mp4" } },
        {
          ...baseOptions,
          targetLanguage: "vi",
          providerAccountFile: "openai_work_1.json",
        },
      ),
    ).toThrow("Xác nhận gửi transcript text");
  });

  it("builds a direct Vietnamese YouTube request without provider runtime", () => {
    expect(
      buildLocalStartJobRequest(
        { jobId: "job_youtube_vi", source: { kind: "youtube", url: "https://youtu.be/abc123" } },
        {
          ...baseOptions,
          sourceLanguage: "vi",
          outputLocationMode: "custom_directory",
          outputDirectory: "/Users/mac/Movies/Subtitles",
        },
      ),
    ).toMatchObject({ targetLanguage: "vi", translationProvider: "none" });
  });

  it("requires Gemini configuration for a non-Vietnamese YouTube request", () => {
    expect(() =>
      buildLocalStartJobRequest(
        { jobId: "job_youtube_en", source: { kind: "youtube", url: "https://youtu.be/abc123" } },
        {
            ...baseOptions,
            sourceLanguage: "en",
            translationProvider: "gemini",
            outputLocationMode: "custom_directory",
          outputDirectory: "/Users/mac/Movies/Subtitles",
        },
      ),
      ).toThrow("Chọn Gemini account");
  });

  it("rejects an OpenAI account instead of silently relabeling it as Gemini", () => {
    expect(() =>
      buildLocalStartJobRequest(
        { jobId: "job_youtube_mismatch", source: { kind: "youtube", url: "https://youtu.be/abc123" } },
        {
          ...baseOptions,
          sourceLanguage: "en",
          translationProvider: "openai",
          providerAccountFile: "openai_work_1.json",
          providerModel: "gpt-5.6-luna",
          translationConsent: true,
          outputLocationMode: "custom_directory",
          outputDirectory: "/Users/mac/Movies/Subtitles",
        },
      ),
    ).toThrow("Gemini");
  });
});
