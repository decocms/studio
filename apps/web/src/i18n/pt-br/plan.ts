import type { plan as planEn } from "../en/plan.ts";

export const plan = {
  "plan.objective.eyebrow": "Seu objetivo na loja",
  "plan.objective.empty":
    "Escreva em uma frase o que a loja precisa agora. Todo plano parte daí.",
  "plan.objective.write": "Escrever o objetivo",
  "plan.objective.edit": "Editar",
  "plan.objective.label": "Objetivo da loja",
  "plan.objective.placeholder":
    "Ex.: Fazer o celular vender tão bem quanto o computador, sem aumentar o investimento em mídia.",
  "plan.objective.hint":
    "Uma frase, do jeito que você diria ao time. Os agentes levam isso para todo plano.",
  "plan.objective.save": "Salvar",
  "plan.objective.cancel": "Cancelar",
  "plan.objective.clear": "Apagar objetivo",
  "plan.objective.saveError": "Não deu para salvar o objetivo. Tente de novo.",
  "plan.idea.heading": "O que você quer melhorar na loja?",
  "plan.idea.description":
    "Descreva a ideia. O agente transforma isso em um business case: o problema em números, quem já faz, o dinheiro em jogo, o esforço e o teste A/B.",
  "plan.idea.label": "Sua ideia",
  "plan.idea.placeholder":
    "Ex.: Mostrar o prazo de entrega na página de produto antes de adicionar ao carrinho.",
  "plan.idea.submit": "Criar o plano",
  "plan.idea.startWith": "Comece por",
  "plan.idea.topic.shipping": "Frete",
  "plan.idea.topic.shippingPrompt": "No frete, ",
  "plan.idea.topic.pdp": "Página de produto",
  "plan.idea.topic.pdpPrompt": "Na página de produto, ",
  "plan.idea.topic.checkout": "Checkout",
  "plan.idea.topic.checkoutPrompt": "No checkout, ",
  "plan.idea.topic.search": "Busca",
  "plan.idea.topic.searchPrompt": "Na busca, ",
  "plan.idea.topic.performance": "Performance",
  "plan.idea.topic.performancePrompt": "Para deixar a loja mais rápida, ",
  "plan.idea.topic.paidMedia": "Mídia paga",
  "plan.idea.topic.paidMediaPrompt": "Para quem chega pela mídia paga, ",
  "plan.prompt.withObjective":
    "Monte um business case para esta ideia. Siga a skill business-case (leia /app/org/public/core/business-case/SKILL.md) e salve o documento nos arquivos da organização.\n\nObjetivo da loja: {objective}\n\nIdeia: {idea}",
  "plan.prompt.withoutObjective":
    "Monte um business case para esta ideia. Siga a skill business-case (leia /app/org/public/core/business-case/SKILL.md) e salve o documento nos arquivos da organização.\n\nIdeia: {idea}",
} satisfies Record<keyof typeof planEn, string>;
