import type { announcements as announcementsEn } from "../en/announcements.ts";

export const announcements = {
  "announcements.ptBr.title": "Português já disponível",
  "announcements.ptBr.description":
    "O Studio agora fala português (Brasil). Quer mudar? Você pode alterar o idioma depois nas configurações.",
  "announcements.ptBr.switch": "Mudar para português",
  "announcements.ptBr.keep": "Manter em inglês",
} satisfies Record<keyof typeof announcementsEn, string>;
