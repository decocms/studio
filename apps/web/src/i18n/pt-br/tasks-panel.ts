import type { tasksPanel as tasksPanelEn } from "../en/tasks-panel.ts";

export const tasksPanel = {
  "tasksPanel.globalSearchDialog.description":
    "Pesquise pelos recursos da sua organização.",
  "tasksPanel.globalSearchDialog.noResults": "Sem resultados.",
  "tasksPanel.globalSearchDialog.placeholder": "Pesquisar...",
  "tasksPanel.globalSearchDialog.recent": "Recentes",
  "tasksPanel.globalSearchDialog.searching": "Pesquisando…",
  "tasksPanel.globalSearchDialog.title": "Pesquisar",
  "tasksPanel.globalSearchDialog.untitledChat": "Chat sem título",
  "tasksPanel.mcpAvatar.automationTriggered": "Disparada por automação",
  "tasksPanel.taskRow.archive": "Arquivar",
  "tasksPanel.taskRow.archiveTask": "Arquivar tarefa",
  "tasksPanel.taskRow.automationTriggered": "Acionado por automação",
  "tasksPanel.taskRow.statusLabel": "Status: {status}",
  "tasksPanel.taskRow.untitledTask": "Tarefa sem título",
} satisfies Record<keyof typeof tasksPanelEn, string>;
