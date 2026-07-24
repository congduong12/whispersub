import type { JobOptions, Provider } from "../../lib/types";

export function syncActiveTranslationAccount(
  options: JobOptions,
  provider: Provider,
  activeAccountFile: string | null,
): JobOptions {
  if (
    options.translationProvider !== provider ||
    options.providerAccountFile === activeAccountFile
  ) {
    return options;
  }

  return {
    ...options,
    providerAccountFile: activeAccountFile,
    providerModel: "",
    translationConsent: false,
  };
}
