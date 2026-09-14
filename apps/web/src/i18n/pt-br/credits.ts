import type { credits as creditsEn } from "../en/credits.ts";

export const credits = {
  "credits.topUp.starter": "Iniciante",
  "credits.topUp.popular": "Popular",
  "credits.topUp.bestValue": "Melhor custo",
  "credits.topUp.enterCustom": "Inserir valor personalizado",
  "credits.topUp.customPlaceholder": "50",
  "credits.topUp.add": "Adicionar",
  "credits.topUp.opening": "Abrindo...",
  "credits.topUp.failed": "Falha ao recarregar: {message}",
} satisfies Record<keyof typeof creditsEn, string>;
