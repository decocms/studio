import type { demo as enDemo } from "../en/demo";
export const demo = {
  "demo.storefront": "Loja publicada da demo",
  "demo.label": "Demonstração",
  "demo.suspended": "Demonstração suspensa",
  "demo.prepare": "Preparar demonstração",
  "demo.ready": "Demonstração restaurada e pronta",
  "demo.taskCreated":
    "Tarefa preparada adicionada. Atribua ao Super Agent para executar.",
  "demo.startSession": "Iniciar apresentação",
  "demo.endSession": "Encerrar apresentação",
  "demo.addScenario": "Adicionar tarefa do roteiro",
  "demo.search": "Busca no cabeçalho",
  "demo.promotion": "Barra promocional",
  "demo.diagnostic": "Corrigir achado do diagnóstico",
  "demo.report": "Diagnóstico demo",
  "demo.resetDescription":
    "Restaurar as tarefas, chats e previews preparados. Isso remove as alterações de apresentações anteriores e interrompe execuções demo atuais. Os membros e o login são preservados. Recarregar a página nunca restaura a demonstração.",
  "demo.cancel": "Cancelar",
  "demo.restore": "Restaurar cenário",
  "demo.preparing": "Preparando…",
} satisfies Record<keyof typeof enDemo, string>;
