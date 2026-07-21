import type { TranslationKey } from "../en/index.ts";
import { settings } from "./settings.ts";

export const ptBR = {
  ...settings,
} satisfies Record<TranslationKey, string>;
