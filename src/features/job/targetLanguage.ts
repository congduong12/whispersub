import type { JobOptions, StartJobRequest } from "../../lib/types";

export type TargetLanguage = StartJobRequest["targetLanguage"];

export interface TargetLanguageChoice {
  value: TargetLanguage;
  label: string;
  available: boolean;
}

export const targetLanguageChoices = [
  {
    value: "none",
    label: "Giữ nguyên theo audio",
    available: true,
  },
    {
      value: "en",
      label: "English",
      available: true,
    },
    {
      value: "vi",
      label: "Tiếng Việt",
      available: true,
    },
  ] as const satisfies readonly TargetLanguageChoice[];

type TranslationSelection = Pick<
    JobOptions,
    | "targetLanguage"
    | "translationProvider"
    | "providerAccountFile"
    | "providerModel"
    | "translationConsent"
  >;

export interface TargetLanguageReadiness {
  ready: boolean;
  reason: string;
}

export function getTargetLanguageReadiness(
  selection: TranslationSelection,
): TargetLanguageReadiness {
    if (selection.targetLanguage === "none") return { ready: true, reason: "" };
    const providerName = selection.translationProvider === "gemini" ? "Gemini" : "OpenAI";
    if (!selection.providerAccountFile) {
      return { ready: false, reason: `Chọn ${providerName} account để dịch transcript.` };
    }
    if (!selection.providerModel.trim()) {
      return { ready: false, reason: `Chọn model ${providerName} dùng để dịch.` };
    }
    if (!selection.translationConsent) {
      return {
        ready: false,
        reason: `Xác nhận gửi transcript text tới ${providerName} cho batch này.`,
      };
  }
  return { ready: true, reason: "" };
}

export function isTargetLanguageReady(selection: TranslationSelection): boolean {
  return getTargetLanguageReadiness(selection).ready;
}
