import type { downloadApp as downloadAppEn } from "../en/download-app.ts";

export const downloadApp = {
  "downloadApp.title": "Baixar o app do deco studio",
  "downloadApp.description":
    "O app é instalado pelo Terminal do seu Mac — copie o comando abaixo, cole lá e pressione Return.",
  "downloadApp.copyLabel": "Copiar comando de instalação",
  "downloadApp.copiedLabel": "Copiado — agora cole no Terminal",
  "downloadApp.terminalHint":
    "Dica: pressione ⌘ Espaço e digite “Terminal” para abri-lo.",
  "downloadApp.appleSiliconNote":
    "Para Macs com Apple Silicon (M1 ou mais novo) — Windows em breve. Requer o Homebrew.",
  "downloadApp.openLabel": "Baixar o app do deco studio",
} satisfies Record<keyof typeof downloadAppEn, string>;
