import type { agentShellLayout as agentShellLayoutEn } from "../en/agent-shell-layout.ts";

export const agentShellLayout = {
  "agentShellLayout.agentShellLayout.runtimeUnavailableOnWeb":
    "Este chat não está disponível na web",
  "agentShellLayout.agentShellLayout.runtimeUnavailableOnWebDescription":
    "Chats com agentes de código são executados localmente no Studio Desktop. Abra este chat lá para continuar.",
  "agentShellLayout.agentShellLayout.agentNotFound": "Agente não encontrado",
  "agentShellLayout.agentShellLayout.agentNotFoundDescription":
    'O agente "{virtualMcpId}" não existe nesta organização.',
  "agentShellLayout.agentShellLayout.chatLoadingError":
    "Algo deu errado ao carregar o chat. Tente atualizar.",
  "agentShellLayout.agentShellLayout.creatingTask": "Criando tarefa…",
  "agentShellLayout.agentShellLayout.goToOrgHome":
    "Ir para a página inicial da organização",
  "agentShellLayout.agentShellLayout.nativeRuntimeUnavailable":
    "O terminal nativo não está disponível. Reinicie o Studio e tente novamente.",
  "agentShellLayout.agentShellLayout.somethingWentWrong":
    "Algo deu errado. Tente atualizar.",
  "agentShellLayout.agentShellLayout.taskUnavailable": "Tarefa indisponível",
  "agentShellLayout.libraryToggle.library": "Biblioteca",
  "agentShellLayout.tasksToggle.tasks": "Tarefas",
  "agentShellLayout.toggleButtons.chat": "Chat",
  "agentShellLayout.toolbar.backToHome": "Voltar para home",
  "agentShellLayout.toolbar.logo": "Logo",
} satisfies Record<keyof typeof agentShellLayoutEn, string>;
