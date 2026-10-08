import type { siteTokens as enSiteTokens } from "../en/site-tokens.ts";

export const siteTokens = {
  "siteTokens.title": "Tokens do site",
  "siteTokens.description":
    "O seu site passa o ID do site e um token para createCMS({ site, token }) para enviar telemetria. Mantenha o token no servidor.",
  "siteTokens.siteId": "ID do site",
  "siteTokens.issue": "Emitir token",
  "siteTokens.issuedAgo": "Emitido {when}",
  "siteTokens.createdTitle": "Copie o token do site",
  "siteTokens.createdDescription":
    "Ele só é mostrado agora. Guarde-o como um segredo de servidor do seu site.",
  "siteTokens.copy": "Copiar token",
  "siteTokens.copied": "Token copiado",
  "siteTokens.done": "Concluir",
} satisfies Record<keyof typeof enSiteTokens, string>;
