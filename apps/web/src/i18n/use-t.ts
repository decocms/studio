import { usePreferences } from "@/hooks/use-preferences.ts";
import { en, type TranslationKey } from "./en/index.ts";
import { interpolate, type InterpolationVars } from "./interpolate.ts";
import type { Locale } from "./locale.ts";
import { ptBR } from "./pt-br/index.ts";

const DICTIONARIES: Record<Locale, Record<TranslationKey, string>> = {
  en,
  "pt-BR": ptBR,
};

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
