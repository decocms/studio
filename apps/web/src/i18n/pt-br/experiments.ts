import type { experiments as enExperiments } from "../en/experiments.ts";

export const experiments = {
  "experiments.title": "Experimentos",
  "experiments.subtitle":
    "Testes A/B deste site. O sorteio de tráfego vive no conteúdo do site; os resultados vêm do analytics.",
  "experiments.new": "Novo experimento",
  "experiments.noSite":
    "Este projeto não tem site vinculado, então não tem experimentos.",
  "experiments.empty.title": "Nenhum experimento ainda",
  "experiments.empty.desc": "Crie o primeiro teste A/B deste site.",
  "experiments.col.name": "Nome",
  "experiments.col.key": "Chave",
  "experiments.col.status": "Status",
  "experiments.col.variants": "Variantes",
  "experiments.dialog.newTitle": "Novo experimento",
  "experiments.dialog.key": "Chave",
  "experiments.dialog.name": "Nome",
  "experiments.dialog.variants": "Variantes",
  "experiments.dialog.weightSum": "Os pesos devem somar 100 (agora {sum})",
  "experiments.dialog.addVariant": "Adicionar variante",
  "experiments.dialog.create": "Criar",
  "experiments.dialog.cancel": "Cancelar",
  "experiments.action.delete": "Excluir",
  "experiments.deleteConfirm":
    'Excluir o experimento "{key}"? Isso não pode ser desfeito.',
  "experiments.results.title": "Resultados",
  "experiments.results.unavailable":
    "O analytics não está configurado neste ambiente, então os resultados não aparecem aqui.",
  "experiments.results.noSiteData":
    "Nenhum tráfego de analytics encontrado para {site}. O site pode ainda não estar enviando eventos de analytics, ou o tráfego dele é registrado sob outro site.",
  "experiments.results.empty": "Ainda sem participantes neste experimento.",
  "experiments.results.control": "Controle",
  "experiments.results.variant": "Variante",
  "experiments.results.visitors": "Visitantes",
  "experiments.results.participants": "Participantes",
  "experiments.results.sampleSize": "Amostra alvo",
  "experiments.results.probBest": "Probabilidade da variante ser melhor",
  "experiments.results.goal": "Objetivo",
} satisfies Record<keyof typeof enExperiments, string>;
