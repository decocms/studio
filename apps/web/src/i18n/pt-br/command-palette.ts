import type { commandPalette as en } from "../en/command-palette";

export const commandPalette = {
  "commandPalette.title": "Paleta de comandos",
  "commandPalette.description":
    "V\u00e1 para uma p\u00e1gina, troque de projeto ou pesquise.",
  "commandPalette.placeholder": "Pesquisar ou ir para\u2026",
  "commandPalette.empty": "Nada encontrado.",
  "commandPalette.goTo": "Ir para",
  "commandPalette.projects": "Projetos",
  "commandPalette.connections": "Conex\u00f5es",
  "commandPalette.actions": "A\u00e7\u00f5es",
  "commandPalette.results": "Resultados",
  "commandPalette.newProject": "Novo projeto",
  "commandPalette.inviteTeammate": "Convidar algu\u00e9m do time",
  "commandPalette.addConnection": "Adicionar uma conex\u00e3o",
  "commandPalette.settings": "Configura\u00e7\u00f5es",
  "commandPalette.placeholderScoped": "Pesquisar {scope}\u2026",
  "commandPalette.organizations": "Organiza\u00e7\u00f5es",
  "commandPalette.scope.label": "Filtrar resultados",
  "commandPalette.scope.all": "Tudo",
  "commandPalette.scope.chats": "Chats e tarefas",
  "commandPalette.hint.navigate": "Navegar",
  "commandPalette.hint.open": "Abrir",
  "commandPalette.hint.filter": "Filtrar",
  "commandPalette.hint.close": "Fechar",
} satisfies Record<keyof typeof en, string>;
