import { settings } from "./settings.ts";

// English is the source of truth: every domain file is spread here and
// TranslationKey is derived from the result. pt-BR mirrors this structure
// and is type-checked against it, so `bun run check` proves completeness.
export const en = {
  ...settings,
} as const;

export type TranslationKey = keyof typeof en;
