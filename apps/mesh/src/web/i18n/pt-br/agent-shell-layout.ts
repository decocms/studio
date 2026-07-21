import type { agentShellLayout as agentShellLayoutEn } from "../en/agent-shell-layout.ts";

export const agentShellLayout = {
  "agentShellLayout.agentShellLayout.agentNotFound":
    "Agente n\u00e3o encontrado",
  "agentShellLayout.agentShellLayout.agentNotFoundDescription":
    'O agente "{virtualMcpId}" n\u00e3o existe nesta organiza\u00e7\u00e3o.',
  "agentShellLayout.agentShellLayout.chatLoadingError":
    "Algo deu errado ao carregar o chat. Tente atualizar.",
  "agentShellLayout.agentShellLayout.creatingTask": "Criando tarefa\u2026",
  "agentShellLayout.agentShellLayout.goToOrgHome":
    "Ir para a p\u00e1gina inicial da organiza\u00e7\u00e3o",
  "agentShellLayout.agentShellLayout.somethingWentWrong":
    "Algo deu errado. Tente atualizar.",
  "agentShellLayout.agentShellLayout.taskUnavailable":
    "Tarefa indispon\u00edvel",
  "agentShellLayout.libraryToggle.library": "Biblioteca",
  "agentShellLayout.tasksToggle.tasks": "Tarefas",
  "agentShellLayout.toggleButtons.chat": "Chat",
  "agentShellLayout.toolbar.backToHome": "Voltar para home",
  "agentShellLayout.toolbar.logo": "Logo",
} satisfies Record<keyof typeof agentShellLayoutEn, string>;
