import type { monitoring as monitoringEn } from "../en/monitoring.ts";

export const monitoring = {
  "monitoring.types.agent": "Agente",
  "monitoring.types.client": "Cliente",
  "monitoring.types.connectionNotFound":
    "N\u00e3o foi poss\u00edvel encontrar a conex\u00e3o para esta chamada de ferramenta",
  "monitoring.types.copiedFilter":
    "Filtro copiado para a \u00e1rea de transfer\u00eancia",
  "monitoring.types.copiedKey":
    "Chave copiada para a \u00e1rea de transfer\u00eancia",
  "monitoring.types.copiedValue":
    "Valor copiado para a \u00e1rea de transfer\u00eancia",
  "monitoring.types.copyFilter": "Copiar filtro",
  "monitoring.types.copyInput": "Copiar entrada",
  "monitoring.types.copyKey": "Copiar chave",
  "monitoring.types.copyOutput": "Copiar sa\u00edda",
  "monitoring.types.copyRequestId": "Copiar ID da solicita\u00e7\u00e3o",
  "monitoring.types.copyValue": "Copiar valor",
  "monitoring.types.downloadFullInput": "Baixar entrada completa",
  "monitoring.types.downloadFullOutput": "Baixar sa\u00edda completa",
  "monitoring.types.duration": "Dura\u00e7\u00e3o",
  "monitoring.types.error": "Erro",
  "monitoring.types.failedToCopy":
    "Falha ao copiar para a \u00e1rea de transfer\u00eancia",
  "monitoring.types.filterByProperty": "Filtrar por esta propriedade",
  "monitoring.types.input": "Entrada",
  "monitoring.types.output": "Sa\u00edda",
  "monitoring.types.properties": "Propriedades",
  "monitoring.types.replayToolCall": "Repetir chamada de ferramenta",
  "monitoring.types.requestId": "ID da solicita\u00e7\u00e3o",
  "monitoring.types.timestamp": "Data e hora",
  "monitoring.types.truncated": "truncado",
  "monitoring.types.user": "Usu\u00e1rio",
} satisfies Record<keyof typeof monitoringEn, string>;
