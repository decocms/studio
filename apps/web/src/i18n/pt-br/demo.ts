import type { demo as enDemo } from "../en/demo";
export const demo = {
  "demo.loading": "Carregando…",
  "demo.unregistered":
    "Esta organização não possui um pacote preparado. Registre uma demonstração nova pela CLI do deployment.",
  "demo.label": "Demonstração",
  "demo.prepare": "Preparar demonstração",
  "demo.ready": "Demonstração restaurada e pronta",
  "demo.resetDescription":
    "Restaurar as tarefas, chats e previews preparados. Isso remove as alterações de apresentações anteriores e interrompe execuções demo atuais. Os membros e o login são preservados. Recarregar a página nunca restaura a demonstração.",
  "demo.cancel": "Cancelar",
  "demo.restore": "Restaurar cenário",
  "demo.preparing": "Preparando…",
} satisfies Record<keyof typeof enDemo, string>;
