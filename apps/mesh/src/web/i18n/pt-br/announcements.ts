import type { announcements as announcementsEn } from "../en/announcements.ts";

export const announcements = {
  "announcements.release.ariaLabel": "Anúncio de lançamento",
  "announcements.release.dismiss": "Dispensar anúncio de lançamento",
  "announcements.release.learnMore": "Saiba mais",
  "announcements.version.ariaLabel": "Atualização do Studio",
  "announcements.version.dismiss": "Dispensar atualização do Studio",
  "announcements.version.eyebrow": "Atualização do Studio",
  "announcements.version.title": "Uma nova versão está pronta",
  "announcements.version.description":
    "Atualize a página para carregar as novidades do Studio.",
  "announcements.version.currentSession": "Sessão atual · {version}",
  "announcements.version.refresh": "Atualizar agora",
} satisfies Record<keyof typeof announcementsEn, string>;
