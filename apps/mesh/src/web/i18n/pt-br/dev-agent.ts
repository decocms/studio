import type { devAgent as devAgentEn } from "../en/dev-agent.ts";

export const devAgent = {
  "devAgent.devAgentSetup.importButton": "Importar do GitHub",
  "devAgent.devAgentSetup.importDialogTitle":
    "Importar um agente de desenvolvimento do GitHub",
  "devAgent.devAgentSetup.linkDescription":
    "Vincule um agente de desenvolvimento com suporte do GitHub. Seu servidor de sandbox em desenvolvimento alimenta uma alternância Desenvolver/Ao vivo para que você possa desenvolver e testar o aplicativo MCP deste agente.",
  "devAgent.devAgentSetup.linkedDescription":
    "Agente de desenvolvimento vinculado — seu servidor de sandbox em desenvolvimento alimenta a alternância Desenvolver/Ao vivo no cabeçalho.",
  "devAgent.devAgentSetup.selectPlaceholder":
    "Ou vincule um agente de desenvolvimento existente…",
  "devAgent.devAgentSetup.title": "Agente de desenvolvimento",
  "devAgent.devAgentSetup.unlinkButton": "Desvincular",
} satisfies Record<keyof typeof devAgentEn, string>;
