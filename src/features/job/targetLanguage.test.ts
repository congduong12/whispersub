import { describe, expect, it } from "vitest";
import {
  getTargetLanguageReadiness,
  isTargetLanguageReady,
  targetLanguageChoices,
  type TargetLanguage,
} from "./targetLanguage";

describe("target-language readiness", () => {
  it.each([
    ["none", true, "Giữ nguyên theo audio"],
    ["en", true, "English"],
    ["vi", true, "Tiếng Việt"],
  ] satisfies Array<[TargetLanguage, boolean, string]>) (
    "maps %s to a selectable target",
    (value, available, label) => {
      const choice = targetLanguageChoices.find((item) => item.value === value);

      expect(choice).toMatchObject({ value, available, label });
    },
  );

    const translation = {
      targetLanguage: "vi" as const,
      translationProvider: "openai" as const,
      providerAccountFile: "openai_work_1.json",
    providerModel: "gpt-5.6-luna",
    translationConsent: true,
  };

  it("keeps original-language jobs ready without provider consent", () => {
    expect(
      getTargetLanguageReadiness({
        ...translation,
        targetLanguage: "none",
        providerAccountFile: null,
        translationConsent: false,
      }),
    ).toEqual({ ready: true, reason: "" });
  });

    it.each([
      [{ ...translation, providerAccountFile: null }, "Chọn OpenAI account"],
      [{ ...translation, providerModel: "  " }, "Chọn model OpenAI"],
      [{ ...translation, translationConsent: false }, "Xác nhận gửi transcript text"],
  ])("explains incomplete translation setup", (options, reason) => {
    const readiness = getTargetLanguageReadiness(options);

    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toContain(reason);
    expect(isTargetLanguageReady(options)).toBe(false);
  });

    it("marks a complete consented translation selection ready", () => {
      expect(isTargetLanguageReady(translation)).toBe(true);
    });

    it("uses the selected provider in readiness copy", () => {
      expect(
        getTargetLanguageReadiness({
          ...translation,
          translationProvider: "gemini",
          providerAccountFile: null,
        }).reason,
      ).toContain("Gemini account");
    });
});
