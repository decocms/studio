import type { plan as planEn } from "../en/plan.ts";

export const plan = {
  "plan.objective.eyebrow": "Seu objetivo na loja",
  "plan.objective.empty":
    "Escreva em uma frase o que a loja precisa agora. Todo plano parte daí.",
  "plan.objective.write": "Escrever o objetivo",
  "plan.objective.suggest": "Sugerir objetivo",
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
  "plan.objective.deciding": "Lendo os dados da loja para escolher o objetivo…",
  "plan.objective.pickedByAi":
    "Escolhido pela IA a partir dos últimos 28 dias da loja. Edite se não fizer sentido.",
  "plan.objective.review": "Revisar com IA",
  "plan.objective.reviewing": "Revisando…",
  "plan.objective.review.same":
    "Os dados da loja ainda apontam para o mesmo objetivo.",
  "plan.objective.review.updated": "Objetivo atualizado com os dados da loja.",
  "plan.objective.review.noData":
    "Ainda não há dados da loja suficientes para escolher um objetivo. O objetivo continua o mesmo.",
  "plan.objective.review.unavailable":
    "A IA não conseguiu revisar o objetivo agora. Tente de novo mais tarde.",
  "plan.objective.review.uncertain":
    "Os dados da loja não apontam um objetivo claro. O objetivo continua o mesmo.",
  "plan.goal.mobile_conversion":
    "Fazer o celular vender tão bem quanto o computador.",
  "plan.goal.checkout_completion":
    "Fazer mais gente que começa o checkout terminar a compra.",
  "plan.goal.cart_to_checkout": "Levar mais carrinhos até o checkout.",
  "plan.goal.product_to_cart":
    "Transformar mais visitas à página de produto em itens no carrinho.",
  "plan.goal.traffic_growth": "Recuperar os visitantes que a loja perdeu.",
  "plan.goal.recover_sales": "Recuperar as vendas que caíram.",
  "plan.goal.average_ticket": "Aumentar o ticket médio dos pedidos.",
  "plan.goal.site_stability": "Parar de perder vendas por erros no site.",
  "plan.idea.heading": "O que você quer melhorar na loja?",
  "plan.idea.description":
    "Fale do jeito que vier, mesmo vago. Você vai para o business case e monta junto com o agente: ele pergunta pelo chat o que precisa e preenche o problema em números, quem já faz, o dinheiro em jogo, o esforço e o teste A/B.",
  "plan.idea.label": "Sua ideia",
  "plan.idea.placeholder":
    "Ex.: Quero mexer na busca. Ou: um guia de vestibilidade na página de produto aumentaria a conversão.",
  "plan.idea.submit": "Montar o business case",
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
    "Vamos montar juntos um business case para este pedido. Siga a skill business-case (leia /app/org/public/core/business-case/SKILL.md). O canvas deste case é {casePath}: rode o init agora, antes de qualquer coisa, e preencha os cards conforme a conversa avança. Se o pedido não diz onde e o quê, me pergunte uma coisa por vez, com opções.\n\nObjetivo da loja: {objective}\n\nPedido: {idea}",
  "plan.prompt.suggestObjective":
    'Sugira um objetivo para a minha loja, a frase de onde todo plano parte. Não me faça perguntas antes.\n\n1. Leia o que você alcança sobre a loja: o Monitor (visitantes, pageviews, pedidos e alertas), o funil e os pedidos pelas tools desta organização, e os arquivos em /app/org/home.\n2. Proponha uma frase de até {max} caracteres, do jeito que eu diria para o meu time (ex.: "Vender tão bem no celular quanto no desktop, sem gastar mais em mídia.").\n3. Embaixo, dê 2 ou 3 motivos. Todo número leva a fonte e a janela ("33% iniciam o checkout, data lake da loja, últimos 7 dias"); número que você não leu não entra.\n4. Diga quais dados você não conseguiu acessar. Se não encontrou nada, proponha a frase mesmo assim e diga que é uma suposição.\n5. Não salve ainda. Pergunte se eu aprovo ou quero mudar. Só depois que eu aprovar, salve com ORGANIZATION_PLAN_OBJECTIVE_SET, usando a minha versão se eu tiver mudado.\n\nResponda no idioma desta mensagem.',
  "plan.prompt.withoutObjective":
    "Vamos montar juntos um business case para este pedido. Siga a skill business-case (leia /app/org/public/core/business-case/SKILL.md). O canvas deste case é {casePath}: rode o init agora, antes de qualquer coisa, e preencha os cards conforme a conversa avança. Se o pedido não diz onde e o quê, me pergunte uma coisa por vez, com opções.\n\nPedido: {idea}",
  "plan.case.waiting": "Abrindo o business case…",
  "plan.case.asking": "Responda no chat",
  "plan.case.assumption": "Suposição:",
  "plan.case.progress": "{filled} de {total} preenchidos",
  "plan.case.openDocument": "Abrir o documento",
  "plan.case.invalid":
    "Não deu para ler a última atualização; mostrando a anterior.",
  "plan.case.objective": "Objetivo da loja",
  "plan.case.noObjective": "Ainda sem objetivo. Escreva um na página Plan.",
  "plan.case.request": "O que você pediu",
  "plan.case.status.framing": "Enquadrando",
  "plan.case.status.building": "Construindo",
  "plan.case.status.ready": "Pronto",
  "plan.case.area.pdp": "Página de produto",
  "plan.case.area.search": "Busca",
  "plan.case.area.category": "Página de categoria",
  "plan.case.area.home": "Home",
  "plan.case.area.cart": "Carrinho",
  "plan.case.area.checkout": "Checkout",
  "plan.case.area.shipping": "Frete",
  "plan.case.area.performance": "Performance",
  "plan.case.area.paidMedia": "Mídia paga",
  "plan.case.area.other": "Outra",
  "plan.case.card.problem": "O problema, medido",
  "plan.case.card.problemQuestion":
    "Em que passo da jornada as pessoas desistem, e quantas?",
  "plan.case.card.scope": "O que vamos mexer",
  "plan.case.card.scopeQuestion":
    "Onde na loja, em qual dispositivo, e o que exatamente?",
  "plan.case.card.money": "Dinheiro em jogo",
  "plan.case.card.moneyQuestion":
    "Quanto vale por mês um ganho pequeno nesse passo?",
  "plan.case.card.competitors": "Quem já faz",
  "plan.case.card.competitorsQuestion":
    "Quais concorrentes já fazem isso, e como?",
  "plan.case.card.measurement": "Como vamos medir",
  "plan.case.card.measurementQuestion":
    "Qual métrica prova que funcionou, e qual não pode piorar?",
  "plan.case.card.abTest": "Teste A/B e prazo",
  "plan.case.card.abTestQuestion":
    "Quantas pessoas e quantas semanas para saber?",
  "plan.case.card.effort": "Esforço e entregas",
  "plan.case.card.effortQuestion":
    "Quantos dias de trabalho, e o que muda na loja?",
  "plan.case.card.risks": "Riscos",
  "plan.case.card.risksQuestion": "O que pode piorar, e o que vamos vigiar?",
  "plan.case.card.unknowns": "O que ainda não sabemos",
  "plan.case.card.unknownsQuestion": "O que falta, e como descobrir?",
  "plan.cases.heading": "Seus business cases",
  "plan.cases.description": "Abra um para ver o canvas e continuar a conversa.",
  "plan.cases.updated": "Atualizado {when}",
  "plan.cases.unreadable": "Não deu para ler este case",
} satisfies Record<keyof typeof planEn, string>;
