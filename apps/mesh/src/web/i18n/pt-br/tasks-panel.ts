import type { tasksPanel as tasksPanelEn } from "../en/tasks-panel.ts";

export const tasksPanel = {
  "tasksPanel.globalSearchDialog.description":
    "Pesquise pelos recursos da sua organiza\u00e7\u00e3o.",
  "tasksPanel.globalSearchDialog.noResults": "Sem resultados.",
  "tasksPanel.globalSearchDialog.placeholder": "Pesquisar...",
  "tasksPanel.globalSearchDialog.searching": "Pesquisando\u2026",
  "tasksPanel.globalSearchDialog.startTyping":
    "Comece a digitar para pesquisar.",
  "tasksPanel.globalSearchDialog.title": "Pesquisar",
  "tasksPanel.globalSearchDialog.untitledChat": "Chat sem t\u00edtulo",
  "tasksPanel.mcpAvatar.automationTriggered":
    "Disparada por automa\u00e7\u00e3o",
  "tasksPanel.taskRow.archive": "Arquivar",
  "tasksPanel.taskRow.archiveTask": "Arquivar tarefa",
  "tasksPanel.taskRow.automationTriggered": "Acionado por automa\u00e7\u00e3o",
  "tasksPanel.taskRow.statusLabel": "Status: {status}",
  "tasksPanel.taskRow.untitledTask": "Tarefa sem t\u00edtulo",
} satisfies Record<keyof typeof tasksPanelEn, string>;
