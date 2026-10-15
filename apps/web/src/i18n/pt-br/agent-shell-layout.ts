import type { agentShellLayout as agentShellLayoutEn } from "../en/agent-shell-layout.ts";

export const agentShellLayout = {
  "agentShellLayout.agentShellLayout.runtimeUnavailableOnWeb":
    "Não é possível continuar este chat",
  "agentShellLayout.agentShellLayout.runtimeUnavailableOnWebDescription":
    "O ambiente de execução original deste chat não é mais suportado. Inicie um novo chat para continuar trabalhando.",
  "agentShellLayout.agentShellLayout.agentNotFound": "Projeto não encontrado",
  "agentShellLayout.agentShellLayout.agentNotFoundDescription":
    'O projeto "{virtualMcpId}" não existe nesta organização.',
  "agentShellLayout.agentShellLayout.chatLoadingError":
    "Algo deu errado ao carregar o chat. Tente atualizar.",
  "agentShellLayout.agentShellLayout.creatingTask": "Criando tarefa…",
  "agentShellLayout.agentShellLayout.goToOrgHome":
    "Ir para a página inicial da organização",
  "agentShellLayout.agentShellLayout.somethingWentWrong":
    "Algo deu errado. Tente atualizar.",
  "agentShellLayout.agentShellLayout.taskUnavailable": "Tarefa indisponível",
  "agentShellLayout.toggleButtons.hideChat": "Ocultar chat",
  "agentShellLayout.toggleButtons.showChat": "Mostrar chat",
  "agentShellLayout.toggleButtons.hidePanel": "Ocultar painel",
  "agentShellLayout.toggleButtons.showPanel": "Mostrar painel",
} satisfies Record<keyof typeof agentShellLayoutEn, string>;
