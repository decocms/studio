import type { monitoring as monitoringEn } from "../en/monitoring.ts";

export const monitoring = {
  "monitoring.types.agent": "Agente",
  "monitoring.types.client": "Cliente",
  "monitoring.types.connectionNotFound":
    "Não foi possível encontrar a conexão para esta chamada de ferramenta",
  "monitoring.types.copiedFilter":
    "Filtro copiado para a área de transferência",
  "monitoring.types.copiedKey": "Chave copiada para a área de transferência",
  "monitoring.types.copiedValue": "Valor copiado para a área de transferência",
  "monitoring.types.copyFilter": "Copiar filtro",
  "monitoring.types.copyInput": "Copiar entrada",
  "monitoring.types.copyKey": "Copiar chave",
  "monitoring.types.copyOutput": "Copiar saída",
  "monitoring.types.copyRequestId": "Copiar ID da solicitação",
  "monitoring.types.copyValue": "Copiar valor",
  "monitoring.types.downloadFullInput": "Baixar entrada completa",
  "monitoring.types.downloadFullOutput": "Baixar saída completa",
  "monitoring.types.duration": "Duração",
  "monitoring.types.error": "Erro",
  "monitoring.types.failedToCopy":
    "Falha ao copiar para a área de transferência",
  "monitoring.types.filterByProperty": "Filtrar por esta propriedade",
  "monitoring.types.input": "Entrada",
  "monitoring.types.output": "Saída",
  "monitoring.types.properties": "Propriedades",
  "monitoring.types.replayToolCall": "Repetir chamada de ferramenta",
  "monitoring.types.requestId": "ID da solicitação",
  "monitoring.types.timestamp": "Data e hora",
  "monitoring.types.truncated": "truncado",
  "monitoring.types.user": "Usuário",
} satisfies Record<keyof typeof monitoringEn, string>;
