import type { TranslationKey } from "../en/index.ts";
import { announcements } from "./announcements.ts";
import { settings } from "./settings.ts";

export const ptBR = {
  ...announcements,
  ...settings,
} satisfies Record<TranslationKey, string>;
