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
        { jobId: "job_local", inputPath: "/video/mixed.mp4" },
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
        { jobId: "job_vi", inputPath: "/video/lesson.mp4" },
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
        { jobId: "job_custom_output", inputPath: "/video/lesson.mp4" },
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
        { jobId: "job_missing_output", inputPath: "/video/lesson.mp4" },
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
        { jobId: "job_gemini", inputPath: "/video/lesson.mp4" },
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
        { jobId: "job_blocked", inputPath: "/video/mixed.mp4" },
        {
          ...baseOptions,
          targetLanguage: "vi",
          providerAccountFile: "openai_work_1.json",
        },
      ),
    ).toThrow("Xác nhận gửi transcript text");
  });
});
