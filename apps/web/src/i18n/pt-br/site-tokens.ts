import type { siteTokens as enSiteTokens } from "../en/site-tokens.ts";

export const siteTokens = {
  "siteTokens.title": "Tokens do site",
  "siteTokens.description":
    "O seu site passa o ID do site e um token para createCMS({ site, token }) para enviar telemetria. Mantenha o token no servidor. No máximo dois podem estar ativos: emita um novo, faça o deploy e revogue o antigo.",
  "siteTokens.siteId": "ID do site",
  "siteTokens.issue": "Emitir token",
  "siteTokens.tooMany":
    "Dois tokens estão ativos. Revogue um antes de emitir outro.",
  "siteTokens.issuedAgo": "Emitido {when}",
  "siteTokens.revokedAgo": "Revogado {when}",
  "siteTokens.revoke": "Revogar",
  "siteTokens.revoked": "Token revogado",
  "siteTokens.revokeTitle": "Revogar este token?",
  "siteTokens.revokeDescription":
    "A telemetria enviada com ele passa a ser recusada em cerca de um minuto. Não é possível desfazer.",
  "siteTokens.createdTitle": "Copie o token do site",
  "siteTokens.createdDescription":
    "Ele só é mostrado agora. Guarde-o como um segredo de servidor do seu site.",
  "siteTokens.copy": "Copiar token",
  "siteTokens.copied": "Token copiado",
  "siteTokens.done": "Concluir",
  "siteTokens.cancel": "Cancelar",
} satisfies Record<keyof typeof enSiteTokens, string>;
