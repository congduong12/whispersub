import { describe, expect, it } from "vitest";
import type { ProviderModelSummary } from "../../lib/types";
import {
  DEFAULT_GEMINI_TRANSLATION_MODEL,
  curateTranslationModels,
  defaultTranslationModel,
  translationModelGroups,
  ungroupedModelLabel,
} from "./translationModelCatalog";

const model = (id: string, displayName: string | null = null): ProviderModelSummary => ({
  id,
  displayName,
});

describe("translation model catalog", () => {
  it("keeps only verified Gemini translation models in policy order", () => {
    const models = [
      model("gemini-3.5-flash", "Gemini 3.5 Flash"),
      model("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview"),
      model("gemma-4-31b-it", "Gemma 4 31B IT"),
      model(DEFAULT_GEMINI_TRANSLATION_MODEL, "Gemini 3.1 Flash Lite"),
      model("gemini-3.1-flash-tts-preview", "Gemini 3.1 Flash TTS Preview"),
    ];

    expect(curateTranslationModels("gemini", models).map((item) => item.id)).toEqual([
      DEFAULT_GEMINI_TRANSLATION_MODEL,
      "gemini-3.5-flash",
      "gemma-4-31b-it",
    ]);
  });

  it("uses Gemini 3.1 Flash Lite as default with a safe fallback", () => {
    const preferred = [
      model("gemini-3.5-flash"),
      model(DEFAULT_GEMINI_TRANSLATION_MODEL),
    ];
    expect(defaultTranslationModel("gemini", preferred)).toBe(
      DEFAULT_GEMINI_TRANSLATION_MODEL,
    );
    expect(defaultTranslationModel("gemini", [model("gemini-3.5-flash")])).toBe(
      "gemini-3.5-flash",
    );
  });

  it("groups Gemini models and adds decision suffixes", () => {
    const groups = translationModelGroups("gemini", [
      model(DEFAULT_GEMINI_TRANSLATION_MODEL, "Gemini 3.1 Flash Lite"),
      model("gemini-flash-latest", "Gemini Flash Latest"),
      model("gemini-3-flash-preview", "Gemini 3 Flash Preview"),
    ]);

    expect(groups.map((group) => group.label)).toEqual([
      "Đề xuất",
      "Tương thích",
      "Preview",
    ]);
    expect(groups[0].options[0].label).toContain("Mặc định · nhanh và ổn định");
    expect(groups[1].options[0].label).toContain("Alias tự cập nhật");
    expect(groups[2].options[0].label).toContain("Có thể thay đổi");
  });

  it("preserves the OpenAI catalog and its existing label format", () => {
    const models = [model("gpt-5.6-luna", "GPT-5.6 Luna")];
    expect(curateTranslationModels("openai", models)).toBe(models);
    expect(defaultTranslationModel("openai", models)).toBe("gpt-5.6-luna");
    expect(translationModelGroups("openai", models)).toEqual([]);
    expect(ungroupedModelLabel(models[0])).toBe("GPT-5.6 Luna · gpt-5.6-luna");
  });
});
