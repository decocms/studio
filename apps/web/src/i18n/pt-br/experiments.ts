import type { experiments as enExperiments } from "../en/experiments.ts";

export const experiments = {
  "experiments.title": "Experimentos",
  "experiments.subtitle":
    "Testes A/B deste site. O sorteio de tráfego é feito pelo Worker deco-ab-testing; os resultados vêm do analytics.",
  "experiments.new": "Novo experimento",
  "experiments.noSite":
    "Este projeto não tem site vinculado, então não tem experimentos.",
  "experiments.empty.title": "Nenhum experimento ainda",
  "experiments.empty.desc": "Crie o primeiro teste A/B deste site.",
  "experiments.summary.total": "Total",
  "experiments.status.running": "Rodando",
  "experiments.status.paused": "Pausado",
  "experiments.status.draft": "Rascunho",
  "experiments.prompt.title": "Descreva seu teste A/B",
  "experiments.prompt.subtitle":
    "Descreva o que você quer testar com suas palavras — a gente transforma isso num rascunho de experimento pra você revisar antes de criar.",
  "experiments.prompt.placeholder":
    "ex.: banner de Dia dos Namorados aparece pra 50% dos usuários, não aparece pros outros 50%",
  "experiments.prompt.example1": "Banner sazonal pra 50% dos visitantes",
  "experiments.prompt.example2": "Botão \"Adicionar ao carrinho\" maior",
  "experiments.prompt.example3": "Texto de urgência na página do produto",
  "experiments.prompt.willGenerate":
    "Gera a chave do teste, nome, variantes com split de tráfego e uma hipótese — tudo editável antes de criar.",
  "experiments.prompt.generate": "Gerar",
  "experiments.prompt.generating": "Gerando…",
  "experiments.prompt.editManually": "Prefiro escrever manualmente",
  "experiments.prompt.backToPrompt": "Voltar ao prompt",
  "experiments.prompt.reviewTitle": "Revise antes de criar",
  "experiments.prompt.hypothesis": "Hipótese",
  "experiments.prompt.regenerate": "Tentar outro prompt",
  "experiments.dialog.newTitle": "Novo experimento",
  "experiments.dialog.editTitle": "Editar experimento",
  "experiments.dialog.key": "Chave do teste",
  "experiments.dialog.keyLocked":
    "A chave não pode mudar depois de criada — é o que o useExperiment() e o Worker usam pra bater.",
  "experiments.dialog.name": "Nome",
  "experiments.dialog.variants": "Variantes",
  "experiments.dialog.weightSum": "Os pesos devem somar 100 (agora {sum})",
  "experiments.dialog.addVariant": "Adicionar variante",
  "experiments.dialog.create": "Criar",
  "experiments.dialog.save": "Salvar",
  "experiments.dialog.cancel": "Cancelar",
  "experiments.action.edit": "Editar",
  "experiments.action.delete": "Excluir",
  "experiments.action.viewData": "Ver dados",
  "experiments.deleteConfirm":
    'Excluir o experimento "{key}"? Isso não pode ser desfeito.',
} satisfies Record<keyof typeof enExperiments, string>;
