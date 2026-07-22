import type { announcements as announcementsEn } from "../en/announcements.ts";

export const announcements = {
  "announcements.ptBr.title": "O Studio agora está em português",
  "announcements.ptBr.description":
    "Notamos que seu navegador está em português, então mudamos o Studio para português (Brasil). Você pode voltar para o inglês quando quiser nas configurações.",
  "announcements.ptBr.ok": "OK!",
  "announcements.ptBr.switchBack": "Voltar para o inglês",
} satisfies Record<keyof typeof announcementsEn, string>;
