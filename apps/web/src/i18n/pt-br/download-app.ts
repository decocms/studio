import type { downloadApp as downloadAppEn } from "../en/download-app.ts";

export const downloadApp = {
  "downloadApp.title": "Baixar o app para desktop",
  "downloadApp.description":
    "Execute este comando no seu terminal para instalar o app com o Homebrew.",
  "downloadApp.copyLabel": "Copiar comando de instalação",
  "downloadApp.appleSiliconNote":
    "Por enquanto, apenas macOS com Apple Silicon. Requer o Homebrew.",
  "downloadApp.openLabel": "Baixar o app para desktop",
} satisfies Record<keyof typeof downloadAppEn, string>;
