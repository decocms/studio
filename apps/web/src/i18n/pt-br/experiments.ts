import type { experiments as enExperiments } from "../en/experiments.ts";

export const experiments = {
  "experiments.title": "Experimentos",
  "experiments.new": "Novo experimento",
  "experiments.noSite":
    "Este projeto não tem site vinculado, então não tem experimentos.",
  "experiments.empty.title": "Nenhum experimento ainda",
  "experiments.empty.desc":
    "Mostre duas versões de uma página para visitantes reais e veja qual vende mais.",
  "experiments.status.running": "Em andamento",
  "experiments.status.paused": "Pausado",
  "experiments.status.draft": "Rascunho",
  "experiments.prompt.title": "Novo experimento",
  "experiments.prompt.subtitle":
    "Diga o que você quer testar. Você revisa tudo antes de ir pro ar.",
  "experiments.prompt.placeholder":
    "ex.: Mostrar um banner de Dia dos Namorados para metade dos visitantes",
  "experiments.prompt.example1": "Banner sazonal pra 50% dos visitantes",
  "experiments.prompt.example2": 'Botão "Adicionar ao carrinho" maior',
  "experiments.prompt.example3": "Texto de urgência na página do produto",
  "experiments.prompt.willGenerate":
    "A gente rascunha o nome, as variantes e o split.",
  "experiments.prompt.generate": "Gerar",
  "experiments.prompt.generating": "Gerando…",
  "experiments.prompt.creating": "Criando e abrindo a PR…",
  "experiments.prompt.editManually": "Escrever manualmente",
  "experiments.prompt.hypothesis": "Hipótese",
  "experiments.prompt.regenerate": "Tentar outro prompt",
  "experiments.prompt.regeneratePlaceholder":
    "Tá errado? Descreve o ajuste e gera de novo.",
  "experiments.dialog.key": "Chave do teste",
  "experiments.dialog.name": "Nome",
  "experiments.dialog.variantDescriptionPlaceholder":
    "Descreva o que essa versão mostra",
  "experiments.dialog.create": "Criar",
  "experiments.dialog.cancel": "Cancelar",
  "experiments.preview.updatePreview": "Atualizar preview",
  "experiments.preview.notSyncedYet":
    'Clica em "Atualizar preview" pra renderizar esse rascunho no site local.',
  "experiments.preview.noUrlTitle": "Sem URL de preview pra esse site",
  "experiments.preview.noUrlDesc":
    "Esse projeto não tem URL de preview/produção configurada, então não dá pra renderizar as variantes aqui.",
  "experiments.preview.saveChanges": "Salvar alterações",
  "experiments.preview.control": "Controle",
  "experiments.implementation.notDelegated":
    "Ainda não foi escrito código para este experimento.",
  "experiments.implementation.delegate": "Escrever o código",
  "experiments.implementation.writing":
    "O Super Agent está escrevendo o código. Ele abre um pull request quando terminar.",
  "experiments.implementation.deploying":
    "O pull request #{number} está aberto — esperando o deploy de preview para comparar antes e depois.",
  "experiments.implementation.ready":
    "Comparando a produção (controle) com o preview do pull request #{number} (tratamento).",
  "experiments.implementation.merged":
    "O pull request #{number} foi mergeado — a mudança já está no site.",
  "experiments.implementation.viewImplementation": "Acompanhar implementação",
  "experiments.implementation.viewPr": "Ver pull request",
  "experiments.preview.openPage": "Abrir página",
  "experiments.confirm.title": 'Criar "{key}" e começar a implementar?',
  "experiments.confirm.withImplement":
    "O Super Agent começa agora a escrever o código no site e abre um PR — sem revisão antes desse PR. O experimento é criado de qualquer forma, mesmo que a implementação não comece (site sem repositório conectado, por exemplo).",
  "experiments.confirm.withoutImplement":
    "Nenhuma variante tem descrição pra implementar, então isso só cria o rascunho — nada muda no front ainda.",
  "experiments.confirm.proceed": "Sim, criar",
  "experiments.confirm.proceedWithImplement": "Criar e implementar",
  "experiments.action.delete": "Excluir",
  "experiments.action.implement": "Abrir PR com o código",
  "experiments.implementConfirm":
    'Delegar a implementação de "{key}" pro Super Agent? Ele vai achar o componente afetado, conectar o experimento e abrir um PR — sem revisão antes desse PR.',
  "experiments.action.viewData": "Ver dados",
  "experiments.deleteConfirm":
    'Excluir o experimento "{key}"? Isso não pode ser desfeito.',
  "experiments.status.ended": "Encerrado",
  "experiments.meta.today": "hoje",
  "experiments.meta.daysAgo": "há {days}d",
  "experiments.meta.started": "Iniciado {when}",
  "experiments.meta.created": "Criado {when}",
  "experiments.meta.ended": "Encerrado {when}",
  "experiments.action.start": "Iniciar teste",
  "experiments.action.pause": "Pausar",
  "experiments.action.resume": "Retomar",
  "experiments.action.end": "Encerrar teste",
  "experiments.action.more": "Mais ações",
  "experiments.split.seeChange": "veem a mudança",
  "experiments.split.even": "Dividir igualmente",
  "experiments.split.reset": "Desfazer",
  "experiments.compare.compare": "Comparar",
  "experiments.compare.desktop": "Desktop",
  "experiments.compare.mobile": "Mobile",
  "experiments.compare.handle": "Arraste para comparar",
  "experiments.deleteTitle": "Excluir este experimento?",
  "experiments.implementTitle": "Implementar com o Super Agent?",
  "experiments.implementProceed": "Delegar",
  "experiments.action.rename": "Renomear",
  "experiments.split.addVariant": "Adicionar variante",
  "experiments.split.removeVariant": "Remover variante",
  "experiments.split.variantName": "Nome da variante",
  "experiments.filter.label": "Filtrar",
  "experiments.filter.status": "Status",
  "experiments.filter.searchLabel": "Buscar experimentos",
  "experiments.filter.searchPlaceholder": "Buscar experimentos…",
  "experiments.filter.searchClear": "Limpar busca",
  "experiments.filter.empty": "Nenhum experimento com esses filtros.",
  "experiments.split.editPercent": "Editar porcentagem de {label}",
  "experiments.compare.pickVariant": "Escolher a variante para comparar",
  "experiments.compare.openArm": "Abrir {arm} em nova aba",
  "experiments.prompt.shortcut": "⌘ Enter",
  "experiments.prompt.tryOne": "Ou comece por uma ideia",

  // Read only by experiments-tab-legacy.tsx; both go when the flag does.
  "experiments.subtitle":
    "Compare versões deste site com tráfego real e veja qual converte melhor.",
  "experiments.col.name": "Nome",
  "experiments.col.key": "Chave",
  "experiments.col.status": "Status",
  "experiments.col.variants": "Variantes",
  "experiments.dialog.newTitle": "Novo experimento",
  "experiments.legacy.dialog.key": "Nome do bloco matcher",
  "experiments.dialog.variants": "Variantes",
  "experiments.dialog.weightSum": "Os pesos devem somar 100 (agora {sum})",
  "experiments.dialog.addVariant": "Adicionar variante",
  "experiments.action.back": "Voltar para a lista",
  "experiments.results.title": "Resultados",
  "experiments.results.unavailable":
    "O analytics não está configurado neste ambiente, então os resultados não aparecem aqui.",
  "experiments.results.noSiteData":
    "Nenhum tráfego de analytics encontrado para {site}. O site pode ainda não estar enviando eventos de analytics, ou o tráfego dele é registrado sob outro site.",
  "experiments.results.empty": "Ainda sem participantes neste experimento.",
  "experiments.results.control": "Controle",
  "experiments.results.test": "Teste",
  "experiments.results.variant": "Variante",
  "experiments.results.weight": "{weight}% do tráfego",
  "experiments.results.arm": "Versão",
  "experiments.results.armsTitle": "Versões",
  "experiments.results.visitors": "Visitantes",
  "experiments.results.visitorsHint":
    "Contados uma vez por dia: quem volta em outro dia conta de novo.",
  "experiments.results.exposed": "Expostos",
  "experiments.results.exposedHint":
    "Visitantes que chegaram ao ponto em que as versões se diferenciam, nas duas versões. É a base mais justa para comparar.",
  "experiments.results.conversion": "Conversão",
  "experiments.results.conversionHintExposed":
    "Dos visitantes expostos, a parte que chegou à meta “{goal}”.",
  "experiments.results.conversionHintVisitors":
    "De todos os visitantes, a parte que chegou à meta “{goal}”.",
  "experiments.results.difference": "Diferença",
  "experiments.results.reference": "Referência",
  "experiments.results.range": "{low} a {high}",
  "experiments.results.orders": "Pedidos",
  "experiments.results.revenue": "Receita",
  "experiments.results.revenuePerVisitor": "Receita por visitante",
  "experiments.results.averageOrder": "Ticket médio",
  "experiments.results.differenceHint":
    "Quanto o teste converte acima ou abaixo do controle, e a faixa onde a diferença real fica com 95% de confiança.",
  "experiments.results.verdict.few": "Poucos dados até agora",
  "experiments.results.verdict.unclear": "Ainda sem diferença clara",
  "experiments.results.verdict.better": "“{arm}” converte mais",
  "experiments.results.verdict.worse": "“{arm}” converte menos",
  "experiments.results.verdict.notWorse": "“{arm}” não é pior que “{control}”",
  "experiments.results.verdict.compareExposed":
    "“{test}” converte {testRate} dos {exposed}, contra {controlRate} de “{control}”.",
  "experiments.results.verdict.compareVisitors":
    "“{test}” converte {testRate} dos visitantes, contra {controlRate} de “{control}”.",
  "experiments.results.verdict.noBase":
    "O controle ainda não teve conversões, então não há base para comparar.",
  "experiments.results.verdict.fewHint":
    "Cada versão precisa de pelo menos {total} visitantes e {successes} conversões para a comparação valer.",
  "experiments.results.claim.lower":
    "A diferença ainda não é {significant}, então o número menor não quer dizer que “{test}” está perdendo.",
  "experiments.results.claim.higher":
    "A diferença ainda não é {significant}, então o número maior não quer dizer que “{test}” está ganhando.",
  "experiments.results.claim.even": "A diferença ainda não é {significant}.",
  "experiments.results.claim.notWorse":
    "A diferença ainda não é {significant}, mas uma queda maior que {bar} já está descartada.",
  "experiments.results.claim.better":
    "A diferença já é {significant}, então o aumento medido vale.",
  "experiments.results.claim.worse":
    "A queda já é {significant}, grande demais para ser acaso.",
  "experiments.results.range.cross":
    "O resultado real pode ir de {low} pior a {high} melhor.",
  "experiments.results.range.above":
    "O resultado real fica entre {near} e {far} melhor.",
  "experiments.results.range.below":
    "O resultado real fica entre {near} e {far} pior.",
  "experiments.results.fact.better": "Chance de “{test}” ser melhor",
  "experiments.results.fact.target": "Chance de ser pelo menos {target} melhor",
  "experiments.results.fact.safety": "Não é pior que {bar}",
  "experiments.results.safety.open": "Ainda não dá para afirmar",
  "experiments.results.safety.openNote":
    "Para afirmar, a diferença medida precisa chegar a {bar}.",
  "experiments.results.safety.notWorse": "Sim, dá para aumentar o tráfego",
  "experiments.results.safety.worse": "Não, a queda é significativa",
  "experiments.results.chanceAbove": "Mais de 99%",
  "experiments.results.chanceBelow": "Menos de 1%",
  "experiments.results.forecast.left":
    "No ritmo atual, chega a ±{margin} em mais {days} dias, com mais {exposed} expostos.",
  "experiments.results.forecast.leftOne":
    "No ritmo atual, chega a ±{margin} em mais 1 dia, com mais {exposed} expostos.",
  "experiments.results.forecast.reached": "Já está abaixo de ±{margin}.",
  "experiments.results.forecast.unknown":
    "Ainda sem dados para estimar quando ela diminui.",
  "experiments.results.progress.running": "No ar há {days} dias.",
  "experiments.results.progress.runningOne": "No ar há 1 dia.",
  "experiments.results.progress.evenSplit":
    "Com metade do tráfego em cada versão, a margem chegaria a ±{margin} em {days} dias.",
  "experiments.results.progress.evenSplitOne":
    "Com metade do tráfego em cada versão, a margem chegaria a ±{margin} em 1 dia.",
  "experiments.results.liftTrend": "Diferença acumulada",
  "experiments.results.liftTrendHint":
    "Cada ponto soma todos os dias até ali. A faixa larga no começo é normal, porque com poucos pedidos um dia bom ou ruim mexe muito no resultado.",
  "experiments.results.chart.aria":
    "Diferença de conversão de “{test}” contra “{control}”, {lift}, com faixa de 95% de {range}.",
  "experiments.results.chart.worse": "Pior",
  "experiments.results.chart.better": "Melhor",
  "experiments.results.chart.measured": "Diferença medida",
  "experiments.results.chart.measuredTotal": "Diferença somando os dias",
  "experiments.results.chart.range": "Faixa de 95%",
  "experiments.results.chart.bar": "Limite de {bar}",
  "experiments.results.chart.tooltip":
    "Medido {lift}, com faixa de 95% de {range}.",
  "experiments.results.chart.tooltipDay": "Diferença até aqui {lift}",
  "experiments.results.glossary.significant": "significativa",
  "experiments.results.glossary.significantTitle": "Significativo",
  "experiments.results.glossary.significantHint":
    "Grande demais para ser acaso. Aqui, quando há pelo menos 95% de confiança de que a diferença real vai na direção medida.",
  "experiments.results.glossary.exposed": "expostos",
  "experiments.results.glossary.exposedTitle": "Exposto",
  "experiments.results.glossary.exposedHint":
    "Visitante que chegou à parte do site que muda entre as versões. A conversão é medida entre eles, e cada um conta uma vez por dia de visita.",
  "experiments.results.glossary.margin": "Margem",
  "experiments.results.glossary.marginTitle": "Margem",
  "experiments.results.glossary.marginHint":
    "Quanto o resultado ainda pode variar só por acaso, para mais ou para menos, com 95% de confiança. Ela diminui conforme o teste junta mais dias.",
  "experiments.results.howTo.title": "Como ler este resultado",
  "experiments.results.howTo.range":
    "A barra mostra onde a diferença real provavelmente está. Enquanto ela cruzar o zero, ganhar e perder ainda são possíveis, mesmo que o ponto medido esteja de um lado.",
  "experiments.results.howTo.early":
    "No começo, poucos pedidos mexem muito na diferença. Um dia bom ou ruim em uma das versões muda o resultado inteiro, por isso a faixa começa larga e vai estreitando.",
  "experiments.results.howTo.looks":
    "A decisão sai do acumulado, nunca de um dia só. Cada olhada no resultado é mais uma chance de ver uma diferença que é só acaso, e quem decide no melhor dia acaba decidindo errado.",
  "experiments.results.howTo.calendar":
    "Dia da semana e efeito novidade também mexem nos primeiros dias, e a faixa não inclui esse efeito.",
  "experiments.results.howTo.method":
    "O cálculo segue o plano de rollout A/B da deco. A confiança é unilateral de 95% sobre a razão das conversões, sem preferência prévia por nenhum resultado, com fator de correção de {deff} porque o sorteio é por visitante e cada visitante conta uma vez por dia. O teste pode crescer quando não é pior que {bar}, e um aumento só vale quando é significativo.",
  "experiments.results.trend": "Conversão por dia",
  "experiments.results.behaviour": "Comportamento por visitante",
  "experiments.results.pageviews": "Páginas vistas",
  "experiments.results.pageviewsHint": "Média de páginas vistas por visitante.",
  "experiments.results.activeTime": "Tempo ativo",
  "experiments.results.activeTimeHint":
    "Tempo médio por visitante com a página aberta e em uso.",
  "experiments.results.clicks": "Cliques",
  "experiments.results.clicksHint": "Média de cliques por visitante.",
  "experiments.results.scroll": "Rolagem mediana",
  "experiments.results.scrollHint": "Até onde a visita típica rola a página.",
  "experiments.results.jsErrors": "Visitantes com erro JS",
  "experiments.results.jsErrorsHint":
    "Visitantes desta versão que tiveram pelo menos um erro de JavaScript em qualquer página do site.",
  "experiments.results.minutes": "{m} min {s} s",
  "experiments.results.seconds": "{s} s",
  "experiments.results.goals": "Metas",
  "experiments.results.goalsHint": "Visitantes que chegaram a cada meta.",
  "experiments.results.goalName.purchase": "Compra",
  "experiments.results.goalName.experience_impression": "Exposição",
  "experiments.results.goal": "Meta",
  "experiments.results.sourceDeco": "Fonte: Deco Analytics",
  "experiments.v8.intro":
    "Seus testes A/B fazem parte do conteúdo do site. Toda mudança fica salva no seu rascunho e vai ao ar quando você publica.",
  "experiments.v8.new": "Novo teste A/B",
  "experiments.v8.allTests": "Todos os testes A/B",
  "experiments.v8.empty.title": "Nenhum teste A/B ainda",
  "experiments.v8.empty.desc":
    "Crie um aqui ou a partir de uma variante no editor do site: escolha a regra “Teste A/B” e digite um nome.",
  "experiments.v8.status.off": "Desligado",
  "experiments.v8.status.running": "Rodando",
  "experiments.v8.status.everyone": "Todos",
  "experiments.v8.state.new": "Ainda não publicado",
  "experiments.v8.state.changed": "Alterado no seu rascunho",
  "experiments.v8.removedTitle": "Removidos no seu rascunho",
  "experiments.v8.removedHint":
    "Estes testes param quando você publicar. Para manter um, crie-o de novo com o mesmo nome.",
  "experiments.v8.shareLabel": "Visitantes que veem o teste",
  "experiments.v8.shareTitle": "Quem vê o teste",
  "experiments.v8.split.inTest": "Veem o teste",
  "experiments.v8.split.rest": "Veem a página como está",
  "experiments.v8.split.center": "veem o teste",
  "experiments.v8.split.reset": "Voltar para {share}%",
  "experiments.v8.shareHint":
    "Arraste o controle ou use as setas do teclado. 0 desliga o teste, 100 mostra para todos. Cada visitante continua no lado que recebeu.",
  "experiments.v8.publishedShare": "Publicado: {share}% dos visitantes",
  "experiments.v8.save": "Salvar",
  "experiments.v8.turnOff": "Desligar",
  "experiments.v8.showEveryone": "Mostrar para todos",
  "experiments.v8.delete": "Excluir teste",
  "experiments.v8.deleted": "Teste “{name}” excluído do seu rascunho",
  "experiments.v8.deletedHint":
    "Ele sai do site quando você publicar. Desfazer traz ele de volta.",
  "experiments.v8.missing.title":
    "Seu site precisa de uma atualização para testes A/B",
  "experiments.v8.missing.desc":
    "Peça ao seu desenvolvedor para atualizar o site para a versão mais recente do Blocks e publicá-lo. Seus testes vão aparecer aqui.",
  "experiments.v8.replaced.title":
    "Seu site cuida dos testes A/B no próprio código",
  "experiments.v8.replaced.desc":
    "Os desenvolvedores definiram os próprios testes, então eles não podem ser alterados aqui. Pergunte a eles como mudar um.",
  "experiments.v8.conflict.title":
    "Seu site já tem um bloco chamado “experiments”",
  "experiments.v8.conflict.desc":
    "Ele não é uma lista de testes A/B, então ainda não dá para adicionar testes. Renomeie esse bloco no editor do site e volte aqui.",
  "experiments.v8.noDraft.title": "Escolha um rascunho para editar seus testes",
  "experiments.v8.noDraft.desc":
    "Seus testes ficam salvos em um rascunho, como qualquer outra edição. Escolha um rascunho na barra acima ou abra o editor do site para começar um.",
  "experiments.v8.loadFailed": "Não foi possível carregar seus testes.",
  "experiments.v8.previewHint":
    "Para ver um teste ligado ou desligado antes de publicar, use “Visualizar como” na pré-visualização do editor do site.",
  "experiments.live.title": "No ar agora",
  "experiments.live.intro": "O que os visitantes recebem no site publicado.",
  "experiments.live.edit": "Editar em Experimentos",
  "experiments.live.editTest": "Editar",
  "experiments.live.viewInMonitor": "Ver no Monitor",
  "experiments.live.unpublished":
    "Seu rascunho tem mudanças nesses testes que ainda não foram publicadas.",
  "experiments.live.empty.title": "Nenhum teste A/B no ar",
  "experiments.live.empty.desc": "Crie um em Experimentos e publique.",
  "experiments.live.noDraft":
    "Abra Experimentos para ver os testes deste site.",
} satisfies Record<keyof typeof enExperiments, string>;
