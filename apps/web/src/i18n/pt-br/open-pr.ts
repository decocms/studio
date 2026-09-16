import type { openPr as enOpenPr } from "../en/open-pr.ts";

export const openPr = {
  "openPr.resolving": "Abrindo este pull request…",
  "openPr.chooser.title": "Escolha onde abrir este pull request",
  "openPr.chooser.subtitle":
    "Este repositório está em mais de um dos seus workspaces. Escolha onde abrir.",
  "openPr.chooser.openAriaLabel": "Abrir {title} em {org}",
  "openPr.notFound.title": "Não encontramos este pull request",
  "openPr.notFound.description":
    "Este repositório não está em nenhum workspace que você tenha acesso. Importe-o no Studio para começar a colaborar.",
  "openPr.error.title": "Algo deu errado",
  "openPr.error.description":
    "Não conseguimos abrir este pull request. Tente novamente.",
  "openPr.retry": "Tentar novamente",
  "openPr.backToStudio": "Ir para o Studio",
} satisfies Record<keyof typeof enOpenPr, string>;
