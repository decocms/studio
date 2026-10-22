import type { experiments as enExperiments } from "../en/experiments.ts";

export const experiments = {
  "experiments.title": "Experimentos",
  "experiments.new": "Novo experimento",
  "experiments.noSite":
    "Este projeto não tem site vinculado, então não tem experimentos.",
  "experiments.empty.title": "Nenhum experimento ainda",
  "experiments.empty.desc": "Crie o primeiro teste A/B deste site.",
  "experiments.status.running": "Rodando",
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
  "experiments.implementation.title": "Implementação",
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
    "Testes A/B deste site. O sorteio de tráfego vive no conteúdo do site; os resultados vêm do analytics.",
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
  "experiments.results.variant": "Variante",
  "experiments.results.visitors": "Visitantes",
  "experiments.results.participants": "Participantes",
  "experiments.results.sampleSize": "Amostra alvo",
  "experiments.results.probBest": "Probabilidade da variante ser melhor",
  "experiments.results.goal": "Objetivo",
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
  "experiments.v8.usedBy": "Usado em {count}",
  "experiments.v8.notUsed": "Ainda não usado",
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
  "experiments.v8.renameHint":
    "Toda variante que usa este teste é atualizada na mesma mudança.",
  "experiments.v8.renamed": "Teste renomeado para “{name}”",
  "experiments.v8.renameWholeHint":
    "Seções que leem todos os testes no próprio código continuam procurando o nome antigo. Atualize-as no editor do site.",
  "experiments.v8.nameLocked":
    "O nome não pode mudar enquanto o teste roda: os visitantes são agrupados por ele. Desligue o teste para renomeá-lo.",
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
} satisfies Record<keyof typeof enExperiments, string>;
