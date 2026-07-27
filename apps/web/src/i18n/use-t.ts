import { readLanguage, usePreferences } from "@/hooks/use-preferences.ts";
import { en, type TranslationKey } from "./en/index.ts";
import { interpolate, type InterpolationVars } from "./interpolate.ts";
import type { Locale } from "./locale.ts";
import { ptBR } from "./pt-br/index.ts";

const DICTIONARIES: Record<Locale, Record<TranslationKey, string>> = {
  en,
  "pt-BR": ptBR,
};

/**
 * Translate outside React.
 *
 * For the few places that must produce user-facing text with no component to
 * hang `useT` on — a global handler installed at boot, for instance. Reads the
 * stored preference the same way `readToolApprovalLevel` does; not reactive,
 * which is fine for a string produced once at the moment it is shown.
 */
export function translate(
  key: TranslationKey,
  vars?: InterpolationVars,
): string {
  return interpolate(DICTIONARIES[readLanguage()][key], vars);
}

/**
 * Translation hook. Reactive to the language preference (localStorage via
 * TanStack Query), so switching language re-renders consumers — no provider.
 */
export function useT() {
  const [preferences] = usePreferences();
  const dictionary = DICTIONARIES[preferences.language];
  return (key: TranslationKey, vars?: InterpolationVars): string =>
    interpolate(dictionary[key], vars);
}

/** Type of the t() function, for helpers that receive it as a parameter. */
export type TFunction = ReturnType<typeof useT>;

export type { TranslationKey } from "./en/index.ts";
