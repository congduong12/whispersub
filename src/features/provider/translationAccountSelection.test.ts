import { describe, expect, it } from "vitest";
import type { JobOptions } from "../../lib/types";
import { syncActiveTranslationAccount } from "./translationAccountSelection";

const options: JobOptions = {
  model: "small",
  sourceLanguage: "auto",
  targetLanguage: "vi",
  translationProvider: "gemini",
  providerAccountFile: "gemini_account_a.json",
  providerModel: "gemini-3.1-flash-lite",
  translationConsent: true,
  device: "auto",
  includeVtt: false,
  outputLocationMode: "same_as_input",
  outputDirectory: null,
};

describe("active translation account selection", () => {
  it("replaces a stale Dashboard account and resets account-bound choices", () => {
    expect(
      syncActiveTranslationAccount(options, "gemini", "gemini_account_b.json"),
    ).toEqual({
      ...options,
      providerAccountFile: "gemini_account_b.json",
      providerModel: "",
      translationConsent: false,
    });
  });

  it("does not change options for another provider or an unchanged account", () => {
    expect(syncActiveTranslationAccount(options, "openai", "openai_work.json")).toBe(
      options,
    );
    expect(
      syncActiveTranslationAccount(options, "gemini", "gemini_account_a.json"),
    ).toBe(options);
  });

  it("clears a stale Dashboard account when the provider has no active account", () => {
    expect(syncActiveTranslationAccount(options, "gemini", null)).toEqual({
      ...options,
      providerAccountFile: null,
      providerModel: "",
      translationConsent: false,
    });
  });
});
