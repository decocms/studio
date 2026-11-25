import type { siteTokens as enSiteTokens } from "../en/site-tokens.ts";

export const siteTokens = {
  "siteTokens.title": "Tokens do site",
  "siteTokens.description":
    "O seu site passa o ID do site e um token para createCMS({ site, token }) para enviar telemetria. Mantenha o token no servidor.",
  "siteTokens.siteId": "ID do site",
  "siteTokens.siteIdDescription":
    "O ID do site não pode mudar: caminhos de CDN, tokens e URLs de assets usam ele.",
  "siteTokens.copySiteId": "Copiar ID do site",
  "siteTokens.siteIdCopied": "ID do site copiado para a área de transferência",
  "siteTokens.issue": "Emitir token",
  "siteTokens.issuedAgo": "Emitido {when}",
  "siteTokens.createdTitle": "Copie o token do site",
  "siteTokens.createdDescription":
    "Ele só é mostrado agora. Guarde-o como um segredo de servidor do seu site.",
  "siteTokens.copy": "Copiar token do site",
  "siteTokens.copied": "Token do site copiado para a área de transferência",
  "siteTokens.done": "Concluir",
  "siteTokens.revoke": "Revogar",
  "siteTokens.revokeLabel": "Revogar o token do site {kid}",
  "siteTokens.revokeTitle": "Revogar este token do site?",
  "siteTokens.revokeDescription":
    "O token {kid} para de funcionar no deco schema push na hora. A telemetria que o site envia com ele continua sendo aceita. Não dá para desfazer.",
  "siteTokens.revoked": "Token do site revogado",
  "siteTokens.cancel": "Cancelar",
} satisfies Record<keyof typeof enSiteTokens, string>;
