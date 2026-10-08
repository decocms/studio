import type { thread as threadEn } from "../en/thread.ts";

export const thread = {
  "thread.branchPicker.allLoaded": "Todas carregadas",
  "thread.branchPicker.branchTooltip": "branch: {branch}",
  "thread.branchPicker.branchesTab": "Branches",
  "thread.branchPicker.couldntLoadBranches":
    "Não foi possível carregar branches do GitHub. Você ainda pode escolher entre suas branches.",
  "thread.branchPicker.couldntLoadPullRequests":
    "Não foi possível carregar pull requests do GitHub.",
  "thread.branchPicker.createBranch": 'Criar "{name}"',
  "thread.branchPicker.advanced": "Avançado",
  "thread.branchPicker.advancedBack": "Voltar",
  "thread.branchPicker.cancel": "Cancelar",
  "thread.branchPicker.defaultVersionName": "Draft",
  "thread.branchPicker.delete": "Descartar",
  "thread.branchPicker.deleteConfirm":
    'Descartar "{name}"? Isso não pode ser desfeito.',
  "thread.branchPicker.deleteTitle": "Descartar draft?",
  "thread.branchPicker.live": "Produção",
  "thread.branchPicker.localTab": "Local",
  "thread.branchPicker.localLabel": "Local",
  "thread.branchPicker.localHint":
    "Aponte o preview e o CMS para o seu próprio dev server. Cole uma URL de túnel público (ex.: ngrok, cloudflared) acessível a partir deste navegador.",
  "thread.branchPicker.localServeConnected":
    "Conectado ao deco serve em {host} (Blocks v8).",
  "thread.branchPicker.localUrlLabel": "URL do túnel local",
  "thread.branchPicker.localUrlPlaceholder": "https://seu-tunel.exemplo.com",
  "thread.branchPicker.localTurnOff": "Desligar",
  "thread.branchPicker.moreActions": "Mais ações",
  "thread.branchPicker.newVersion": "Novo Draft",
  "thread.branchPicker.capReached":
    "Limite de {max} versões atingido. Exclua uma versão para criar outra.",
  "thread.branchPicker.rename": "Renomear",
  "thread.branchPicker.save": "Salvar",
  "thread.branchPicker.saveError":
    "Não foi possível salvar a versão. Tente novamente.",
  "thread.branchPicker.selectVersion": "Selecione uma versão",
  "thread.branchPicker.newChatHint":
    "A branch deste chat é fixa. Escolher ou criar uma branch abre um chat novo nela.",
  "thread.branchPicker.hiddenForkPrs":
    "{count} PR(s) de forks ocultado(s) — abra em uma branch deste repositório",
  "thread.branchPicker.last7Days": "Últimos 7 dias",
  "thread.branchPicker.loadMoreBranches": "Carregar mais branches",
  "thread.branchPicker.loadingMore": "Carregando mais…",
  "thread.branchPicker.loadingPullRequests": "Carregando pull requests…",
  "thread.branchPicker.moreMatches":
    "Mais {count} resultado(s) — refine sua busca",
  "thread.branchPicker.new": "Nova",
  "thread.branchPicker.noBranchesFound": "Nenhuma branch encontrada.",
  "thread.branchPicker.noPullRequestsFound":
    "Nenhum pull request corresponde à sua busca.",
  "thread.branchPicker.noOpenPullRequests": "Nenhum pull request aberto.",
  "thread.branchPicker.openPullRequests": "Pull requests abertos",
  "thread.branchPicker.otherBranchesInRepo": "Outras branches no repositório",
  "thread.branchPicker.prsTab": "PRs",
  "thread.branchPicker.searchBranches": "Pesquisar branches…",
  "thread.branchPicker.searchingBranches": "Pesquisando branches…",
  "thread.branchPicker.searchPullRequests": "Pesquisar pull requests…",
  "thread.branchPicker.selectBranch": "Selecione uma branch…",
  "thread.branchPicker.yourBranches": "Suas branches",
  "thread.cmsActions.checksFailing":
    "{failed} de {total} verificações não estão passando",
  "thread.cmsActions.checksRunning": "Verificando {done} de {total} concluídas",
  "thread.cmsActions.getLatest": "Obter atualizações",
  "thread.cmsActions.getLatestTooltip":
    "Trazer as novas alterações da produção",
  "thread.cmsActions.moreActionsAriaLabel": "Mais ações",
  "thread.cmsActions.publishing": "Publicando…",
  "thread.cmsActions.gettingLatest": "Obtendo atualizações…",
  "thread.cmsActions.retry": "Tentar novamente",
  "thread.cmsActions.resolveOnProvider": "Resolver no provedor",
  "thread.cmsActions.reviewAndPublish": "Revisar e publicar",
  "thread.cmsActions.viewOnProvider": "Ver no provedor",
  "thread.cmsActions.waitingForReview": "Aguardando revisão",
  "thread.headerActions.addressFeedback": "Tratar feedback",
  "thread.headerActions.branchInSyncTooltip": "Branch sincronizada com {base}",
  "thread.headerActions.chatIsRunning": "Chat está em execução",
  "thread.headerActions.checkingOutTooltip": "Fazendo checkout de {branch}",
  "thread.headerActions.cloneFailed": "Clone falhou",
  "thread.headerActions.cloneFailedDefaultTooltip":
    "git clone falhou — veja os logs de configuração",
  "thread.headerActions.cloningRepo": "Clonando repositório…",
  "thread.headerActions.cloningRepoTooltip":
    "Clonando o repositório do projeto",
  "thread.headerActions.continue": "Continuar",
  "thread.headerActions.failedToMergePullRequest":
    "Falha ao mesclar a pull request",
  "thread.headerActions.failingChecksTooltip": "Falhando: {checks}",
  "thread.headerActions.fixChecks": "Corrigir checks",
  "thread.headerActions.githubConnectionRemoved":
    "A conexão do GitHub foi removida — revincula o repositório em Configurações para salvar alterações",
  "thread.headerActions.installingPackages": "Instalando pacotes…",
  "thread.headerActions.installingPackagesTooltip":
    "Instalando dependências — ainda não há nada para revisar ou publicar",
  "thread.headerActions.loading": "Carregando…",
  "thread.headerActions.loadingBranch": "Carregando branch…",
  "thread.headerActions.loadingBranchTooltip":
    "Carregando branch e status do pull request",
  "thread.headerActions.markReady": "Marcar como pronto",
  "thread.headerActions.markDraftReadyTooltip":
    "Marcar PR rascunho como pronto para revisão",
  "thread.headerActions.moreActionsAriaLabel": "Mais ações",
  "thread.headerActions.openNewPrTooltip":
    "Abrir um novo PR com os últimos commits",
  "thread.headerActions.prMergedTooltip": "PR #{prNumber} mesclado em {base}",
  "thread.headerActions.publishAnyway": "Publicar mesmo assim",
  "thread.headerActions.publishedPr": "PR #{prNumber} publicado",
  "thread.headerActions.reconnectGithub": "Reconectar GitHub",
  "thread.headerActions.review": "Revisar",
  "thread.headerActions.saving": "Salvando…",
  "thread.headerActions.syncedWithBase": "Sincronizado com {base}",
  "thread.headerActions.reopenPr": "Reabrir PR",
  "thread.headerActions.reopenPrTooltip": "Reabrir PR #{prNumber}",
  "thread.headerActions.squashMergeTooltip":
    "Squash-merge do PR #{prNumber} em {base}",
  "thread.headerActions.startingApp": "Iniciando app…",
  "thread.headerActions.startingAppTooltip":
    "Iniciando o servidor de desenvolvimento — ainda não há trabalho commitado para revisar ou publicar",
  "thread.headerActions.startingSandbox": "Preparando sandbox…",
  "thread.headerActions.submitForReview": "Enviar para revisão",
  "thread.headerActions.switchingTo": "Mudando para {branch}…",
  "thread.headerActions.unresolvedConversationsTooltip":
    "{count} conversa(s) não resolvida(s)",
  "thread.headerActions.upToDate": "Atualizado",
  "thread.headerActions.waitingForApprovalsTooltip":
    "Aguardando aprovações obrigatórias",
  "thread.headerActions.waitingForBranchTooltip":
    "Quase lá — terminando de preparar seu ambiente",
  "thread.headerActions.waitingForDaemonTooltip":
    "Preparando seu ambiente — leva só um instante",
  "thread.headerActions.waitingForSandboxBranchTooltip":
    "Preparando seu ambiente — leva só um instante",
  "thread.publishDialog.allChangesDiscarded":
    "Todas as alterações foram descartadas",
  "thread.publishDialog.cancel": "Cancelar",
  "thread.publishDialog.changesFrom": "Alterações de {branch}",
  "thread.publishDialog.failedMergePullRequest":
    "Falha ao mesclar pull request",
  "thread.publishDialog.failedOpenPullRequest": "Falha ao abrir pull request",
  "thread.publishDialog.failedPublish": "Falha ao publicar",
  "thread.publishDialog.failedPushChanges": "Falha ao enviar alterações",
  "thread.publishDialog.failedRebase": "Falha ao rebasar para a base",
  "thread.publishDialog.failedSubmitForReview": "Falha ao enviar para revisão",
  "thread.publishDialog.mergeFailed":
    "Alterações foram enviadas e PR #{prNumber} está aberto, mas a mesclagem falhou: {message}",
  "thread.mergeRefused.conflict":
    "Conflita com a branch base — faça rebase e tente de novo.",
  "thread.mergeRefused.blocked":
    "O repositório recusou o merge — falta uma revisão obrigatória ou uma regra de branch.",
  "thread.mergeRefused.rateLimited":
    "O provider está limitando as requisições — tente de novo em instantes.",
  "thread.mergeRefused.notFound": "Não existe mais.",
  "thread.mergeRefused.error": "Falha ao fazer merge.",
  "thread.publishDialog.openingComparison": "Abrindo a comparação…",
  "thread.publishDialog.publishedTo": "Publicado em {baseBranch}",
  "thread.publishDialog.submittedForReview":
    "Pull request #{prNumber} enviado para revisão",
  "thread.publishDialog.viewOnProvider": "Ver no provedor",
  "thread.publishDialog.viewPr": "Ver PR",
  "thread.publishPopover.blocksGroup": "Blocos",
  "thread.publishPopover.mergedCurrent": "Mesclado · Atual na CDN",
  "thread.publishPopover.mergedNotCurrent":
    "Mesclado · versão criada, mas não foi possível torná-la atual — use Tornar atual em Versões",
  "thread.publishPopover.mergedNoRelease":
    "Mesclado · nenhuma versão criada (a próxima publicação inclui estas alterações)",
  "thread.publishPopover.upToDate": "Tudo atualizado, nada para publicar",
  "thread.publishPopover.mainMoved":
    "A main mudou durante a publicação, então nada foi publicado. Publique novamente.",
  "thread.publishPopover.branchMoved":
    "Esta branch mudou depois que estas alterações foram exibidas. Feche e abra novamente para revisar o que será publicado.",
  "thread.publishPopover.detailsUnavailable":
    "Não foi possível carregar os detalhes destas alterações.",
  "thread.publishPopover.loadFailed":
    "Não foi possível carregar suas alterações",
  "thread.publishPopover.retry": "Tentar novamente",
  "thread.publishPopover.showingFirst":
    "Mostrando as primeiras {shown} de {total} alterações",
  "thread.publishPopover.chipEdited": "Editado",
  "thread.publishPopover.chipNew": "Novo",
  "thread.publishPopover.chipRemoved": "Removido",
  "thread.publishPopover.emptyHint":
    "Suas alterações mais recentes já estão no ar.",
  "thread.publishPopover.everythingLive": "Tudo publicado",
  "thread.publishPopover.failedDiscard": "Falha ao descartar alterações",
  "thread.publishPopover.globalSection": "Seção global",
  "thread.publishPopover.lastPublished": "Última publicação {when}",
  "thread.publishPopover.lastPublishedBy":
    "Última publicação {when} por {name}",
  "thread.publishPopover.needsReviewGeneric":
    "Estas alterações precisam da revisão de um colega antes de irem ao ar",
  "thread.publishPopover.newPageSections": "Página nova com {count} seções",
  "thread.publishPopover.newPageSectionOne": "Página nova com 1 seção",
  "thread.publishPopover.sectionsChanged": "{count} seções alteradas",
  "thread.publishPopover.sectionChangedOne": "1 seção alterada",
  "thread.publishPopover.fieldsChanged": "{count} campos alterados",
  "thread.publishPopover.fieldChangedOne": "1 campo alterado",
  "thread.publishPopover.pageSettingsChanged":
    "Configurações da página alteradas",
  "thread.publishPopover.nothingToSubmit": "Nada para enviar",
  "thread.publishPopover.otherGroup": "Outras alterações",
  "thread.publishPopover.pagesGroup": "Páginas",
  "thread.publishPopover.preview": "Visualizar",
  "thread.publishPopover.publish": "Publicar",
  "thread.publishPopover.publishCount": "Publicar {count} alterações",
  "thread.publishPopover.publishCountInProduction":
    "Publicar {count} alterações em produção",
  "thread.publishPopover.publishOneInProduction":
    "Publicar 1 alteração em produção",
  "thread.publishPopover.publishOne": "Publicar 1 alteração",
  "thread.publishPopover.publishedTo": "Publicado em {host}",
  "thread.publishPopover.publishing": "Publicando…",
  "thread.publishPopover.requestApproval": "Pedir aprovação",
  "thread.publishPopover.discarded": "{name} descartado",
  "thread.publishPopover.discard": "Descartar",
  "thread.publishPopover.discardAll": "Descartar tudo",
  "thread.publishPopover.discardAllConfirm": "Isso não pode ser desfeito.",
  "thread.publishPopover.discardAllTitle": "Descartar todas as alterações?",
  "thread.publishPopover.reviewNote": "Nota para quem revisa",
  "thread.publishPopover.reviewNotePlaceholder": "O que mudou e por quê…",
  "thread.publishPopover.reviewing": "Revisando conteúdo…",
  "thread.publishPopover.siteConfiguration": "Configuração do site",
  "thread.publishPopover.submitCountForReview":
    "Enviar {count} alterações para revisão",
  "thread.publishPopover.submitEmptyHint":
    "Este chat não tem alterações aguardando revisão.",
  "thread.publishPopover.submitForReview": "Enviar para revisão",
  "thread.publishPopover.submitOneForReview": "Enviar 1 alteração para revisão",
  "thread.publishPopover.submitting": "Enviando…",
  "thread.publishPopover.versionNote": "Nota da versão",
  "thread.publishPopover.updatesPullRequest":
    "Atualiza o pull request #{number}",
  "thread.publishPopover.versionNotePlaceholder": "Descreva esta atualização…",
  "thread.publishCompare.sideBySide": "Lado a lado",
  "thread.publishCompare.before": "Antes",
  "thread.publishCompare.after": "Depois",
  "thread.publishCompare.code": "Código",
  "thread.publishCompare.pathLabel": "Endereço da página",
  "thread.publishCompare.desktop": "Desktop",
  "thread.publishCompare.mobile": "Celular",
  "thread.publishCompare.openDraft": "Abrir em nova aba",
  "thread.publishCompare.globalHint":
    "Esta alteração pode aparecer em qualquer página. Mostrando a página inicial — digite outro endereço para comparar.",
  "thread.publishCompare.dynamicHint":
    "O endereço desta página é um padrão ({template}). Digite um endereço real para comparar.",
  "thread.publishCompare.enterPath":
    "Digite o endereço de uma página para comparar.",
  "thread.publishCompare.draftUnavailable":
    "Ainda não é possível mostrar suas alterações. Use Visualizar para abri-las.",
  "thread.publishCompare.newTitle": "Página nova",
  "thread.publishCompare.newDescription":
    "Esta página ainda não existe no site publicado.",
  "thread.publishCompare.removedTitle": "Página removida",
  "thread.publishCompare.removedDescription":
    "Esta página deixará de existir no site.",
  "thread.analytics.title": "Chats e automações",
  "thread.analytics.notAdmin":
    "A análise de chats só está disponível em uma organização administradora.",
  "thread.analytics.tabLive": "Ao vivo",
  "thread.analytics.tabUsage": "Uso",
  "thread.analytics.tabErrors": "Erros",
  "thread.analytics.statusRunning": "Em execução",
  "thread.analytics.statusWaiting": "Aguardando",
  "thread.analytics.statusFailed": "Falhou",
  "thread.analytics.statusCompleted": "Concluído",
  "thread.analytics.kindChat": "Chat",
  "thread.analytics.kindAutomation": "Automação",
  "thread.analytics.kindTask": "Execução de tarefa",
  "thread.analytics.anyStatus": "Qualquer status",
  "thread.analytics.anyKind": "Qualquer tipo",
  "thread.analytics.liveHint": "Atualiza ao vivo",
  "thread.analytics.countRunning": "Em execução agora",
  "thread.analytics.countWaiting": "Aguardando uma pessoa",
  "thread.analytics.countFailedHour": "Falhas na última hora",
  "thread.analytics.empty": "Nenhum chat ainda.",
  "thread.analytics.untitled": "Chat sem título",
  "thread.analytics.colUpdated": "Atualizado",
  "thread.analytics.colOrg": "Org",
  "thread.analytics.colChat": "Chat",
  "thread.analytics.colKind": "Tipo",
  "thread.analytics.colStatus": "Status",
  "thread.analytics.colUser": "Usuário",
  "thread.analytics.colAgent": "Agente",
  "thread.analytics.colCost": "Custo",
  "thread.analytics.colTokens": "Tokens",
  "thread.analytics.costFootnote":
    "O custo é um piso: só turnos precificados pela OpenRouter informam USD. Confira a cobertura de custo antes de ler os totais.",
} satisfies Record<keyof typeof threadEn, string>;
