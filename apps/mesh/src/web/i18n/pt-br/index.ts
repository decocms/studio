import type { TranslationKey } from "../en/index.ts";
import { announcements } from "./announcements.ts";
import { chat } from "./chat.ts";
import { settings } from "./settings.ts";

export const ptBR = {
  ...announcements,
  ...chat,
  ...settings,
} satisfies Record<TranslationKey, string>;
