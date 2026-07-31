import type { announcements as announcementsEn } from "../en/announcements.ts";

export const announcements = {
  "announcements.ptBr.title": "O Studio agora está em português",
  "announcements.ptBr.description":
    "Notamos que seu navegador está em português, então mudamos o Studio para português (Brasil). Você pode voltar para o inglês quando quiser nas configurações.",
  "announcements.ptBr.ok": "OK!",
  "announcements.ptBr.switchBack": "Voltar para o inglês",
  "announcements.release.ariaLabel": "Anúncio de lançamento",
  "announcements.release.dismiss": "Dispensar anúncio de lançamento",
  "announcements.release.learnMore": "Saiba mais",
  "announcements.version.ariaLabel": "Atualização do Studio",
  "announcements.version.dismiss": "Dispensar atualização do Studio",
  "announcements.version.eyebrow": "Atualização do Studio",
  "announcements.version.title": "Uma nova versão está pronta",
  "announcements.version.description":
    "Atualize a página para carregar as novidades do Studio.",
  "announcements.version.descriptionNative":
    "Uma atualização está pronta. Reinicie o aplicativo para concluir a instalação.",
  "announcements.version.currentSession": "Sessão atual · {version}",
  "announcements.version.refresh": "Atualizar agora",
  "announcements.version.restart": "Reiniciar para atualizar",
} satisfies Record<keyof typeof announcementsEn, string>;
