import type { downloadApp as downloadAppEn } from "../en/download-app.ts";

export const downloadApp = {
  "downloadApp.title": "Baixar o app do Studio",
  "downloadApp.description":
    "O app é instalado pelo Terminal do seu Mac — copie o comando abaixo, cole lá e pressione Return.",
  "downloadApp.copyLabel": "Copiar comando de instalação",
  "downloadApp.copiedLabel": "Copiado — agora cole no Terminal",
  "downloadApp.terminalHint":
    "Dica: pressione ⌘ Espaço e digite “Terminal” para abri-lo.",
  "downloadApp.appleSiliconNote":
    "Para Macs com Apple Silicon (M1 ou mais novo) — Windows em breve.",
  "downloadApp.openLabel": "Baixar o app do Studio",
  "downloadApp.installOnMac": "Instalar no Mac",
  "downloadApp.linuxDescription":
    "O app vem como um único AppImage — baixe, torne-o executável e execute. Sem instalador, sem root.",
  "downloadApp.downloadAppImage": "Baixar o AppImage",
  "downloadApp.linuxChmodHint":
    "Antes torne-o executável: rode chmod +x no arquivo baixado ou marque “Permitir execução do arquivo como programa” nas propriedades dele.",
  "downloadApp.linuxArchNote":
    "Para Linux x86 de 64 bits (x86_64) — Arm e Windows em breve.",
  "downloadApp.allReleases": "Ver todas as versões",
  "downloadApp.installOnLinux": "Instalar no Linux",
} satisfies Record<keyof typeof downloadAppEn, string>;
