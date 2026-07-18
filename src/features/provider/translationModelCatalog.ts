import type { Provider, ProviderModelSummary } from "../../lib/types";

export const DEFAULT_GEMINI_TRANSLATION_MODEL = "gemini-3.1-flash-lite";

type GeminiModelGroup = "recommended" | "compatible" | "preview";

interface GeminiModelPolicy {
  id: string;
  group: GeminiModelGroup;
  suffix: string;
}

export interface TranslationModelOption {
  model: ProviderModelSummary;
  label: string;
}

export interface TranslationModelGroup {
  id: GeminiModelGroup;
  label: string;
  options: TranslationModelOption[];
}

const geminiModelGroups: Array<{ id: GeminiModelGroup; label: string }> = [
  { id: "recommended", label: "Đề xuất" },
  { id: "compatible", label: "Tương thích" },
  { id: "preview", label: "Preview" },
];

const geminiTranslationModels: GeminiModelPolicy[] = [
  {
    id: DEFAULT_GEMINI_TRANSLATION_MODEL,
    group: "recommended",
    suffix: "Mặc định · nhanh và ổn định",
  },
  {
    id: "gemini-3.5-flash",
    group: "recommended",
    suffix: "Chất lượng cao · có thể chậm",
  },
  {
    id: "gemini-flash-lite-latest",
    group: "compatible",
    suffix: "Alias tự cập nhật",
  },
  {
    id: "gemini-flash-latest",
    group: "compatible",
    suffix: "Alias tự cập nhật",
  },
  {
    id: "gemma-4-26b-a4b-it",
    group: "compatible",
    suffix: "Đã xác minh",
  },
  {
    id: "gemma-4-31b-it",
    group: "compatible",
    suffix: "Đã xác minh",
  },
  {
    id: "gemini-3-flash-preview",
    group: "preview",
    suffix: "Có thể thay đổi",
  },
];

function modelLabel(model: ProviderModelSummary, suffix?: string): string {
  const displayName = model.displayName?.trim();
  const identity = displayName && displayName !== model.id
    ? `${displayName} · ${model.id}`
    : model.id;
  return suffix ? `${identity} · ${suffix}` : identity;
}

export function curateTranslationModels(
  provider: Provider,
  models: ProviderModelSummary[],
): ProviderModelSummary[] {
  if (provider !== "gemini") return models;
  const modelsById = new Map(models.map((model) => [model.id, model]));
  return geminiTranslationModels.flatMap((policy) => {
    const model = modelsById.get(policy.id);
    return model ? [model] : [];
  });
}

export function defaultTranslationModel(
  provider: Provider,
  models: ProviderModelSummary[],
): string {
  if (
    provider === "gemini" &&
    models.some((model) => model.id === DEFAULT_GEMINI_TRANSLATION_MODEL)
  ) {
    return DEFAULT_GEMINI_TRANSLATION_MODEL;
  }
  return models[0]?.id ?? "";
}

export function translationModelGroups(
  provider: Provider,
  models: ProviderModelSummary[],
): TranslationModelGroup[] {
  if (provider !== "gemini") return [];
  const modelsById = new Map(models.map((model) => [model.id, model]));
  return geminiModelGroups.flatMap((group) => {
    const options = geminiTranslationModels
      .filter((policy) => policy.group === group.id)
      .flatMap((policy) => {
        const model = modelsById.get(policy.id);
        return model ? [{ model, label: modelLabel(model, policy.suffix) }] : [];
      });
    return options.length ? [{ ...group, options }] : [];
  });
}

export function ungroupedModelLabel(model: ProviderModelSummary): string {
  return modelLabel(model);
}
