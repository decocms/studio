import type { commandPalette as en } from "../en/command-palette";

export const commandPalette = {
  "commandPalette.title": "Paleta de comandos",
  "commandPalette.description":
    "V\u00e1 para uma p\u00e1gina, troque de projeto ou pesquise.",
  "commandPalette.placeholder": "Pesquisar ou ir para\u2026",
  "commandPalette.empty": "Nada encontrado.",
  "commandPalette.goTo": "Ir para",
  "commandPalette.projects": "Projetos",
  "commandPalette.actions": "A\u00e7\u00f5es",
  "commandPalette.results": "Resultados",
  "commandPalette.newProject": "Novo projeto",
  "commandPalette.inviteTeammate": "Convidar algu\u00e9m do time",
  "commandPalette.addConnection": "Adicionar uma conex\u00e3o",
  "commandPalette.settings": "Configura\u00e7\u00f5es",
} satisfies Record<keyof typeof en, string>;
