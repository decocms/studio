import type { thread as threadEn } from "../en/thread.ts";

export const thread = {
  "thread.branchPicker.allLoaded": "Todas carregadas",
  "thread.branchPicker.branchesTab": "Branches",
  "thread.branchPicker.couldntLoadBranches":
    "Não foi possível carregar branches do GitHub. Você ainda pode escolher entre suas branches.",
  "thread.branchPicker.couldntLoadPullRequests":
    "Não foi possível carregar pull requests do GitHub.",
  "thread.branchPicker.createBranch": 'Criar "{name}"',
  "thread.branchPicker.hiddenForkPrs":
    "{count} PR(s) de forks ocultado(s) — abra em uma branch deste repositório",
  "thread.branchPicker.last7Days": "Últimos 7 dias",
  "thread.branchPicker.loadMoreBranches": "Carregar mais branches",
  "thread.branchPicker.loadingMore": "Carregando mais…",
  "thread.branchPicker.loadingPullRequests": "Carregando pull requests…",
  "thread.branchPicker.lookingThroughMoreBranches": "Procurando mais branches…",
  "thread.branchPicker.new": "Nova",
  "thread.branchPicker.noBranchesFound": "Nenhuma branch encontrada.",
  "thread.branchPicker.noPullRequestsFound":
    "Nenhum pull request corresponde à sua busca.",
  "thread.branchPicker.noOpenPullRequests": "Nenhum pull request aberto.",
  "thread.branchPicker.openPullRequests": "Pull requests abertos",
  "thread.branchPicker.otherBranchesInRepo": "Outras branches no repositório",
  "thread.branchPicker.prsTab": "PRs",
  "thread.branchPicker.searchLoadedBranches": "Pesquisar branches carregadas…",
  "thread.branchPicker.searchPullRequests": "Pesquisar pull requests…",
  "thread.branchPicker.selectBranch": "Selecione uma branch…",
  "thread.branchPicker.yourBranches": "Suas branches",
  "thread.changesTab.couldntLoadPrChanges":
    "Não foi possível carregar mudanças do PR.",
  "thread.changesTab.loadingChanges": "Carregando mudanças…",
  "thread.changesTab.noCommittedChanges":
    "Nenhuma mudança confirmada neste pull request",
  "thread.checksTab.couldntLoadCheckDetail":
    "Não foi possível carregar o detalhe desta verificação.",
  "thread.checksTab.couldntLoadCheckRuns":
    "Não foi possível carregar as verificações.",
  "thread.checksTab.failure": "Falha",
  "thread.checksTab.inProgress": "Em progresso",
  "thread.checksTab.loadingCheckDetail": "Carregando detalhe…",
  "thread.checksTab.loadingChecks": "Carregando verificações…",
  "thread.checksTab.noCheckDetail": "Esta verificação não tem detalhe.",
  "thread.checksTab.noCheckRunsOnPrHeadCommit":
    "Nenhuma verificação no commit principal do PR.",
  "thread.checksTab.rerun": "Executar novamente",
  "thread.checksTab.success": "Sucesso",
  "thread.checksTab.viewRun": "Ver execução",
  "thread.gitTab.by": "por @{author}",
  "thread.gitTab.closed": "✗ Fechado",
  "thread.gitTab.couldNotLoadPrState":
    "Não foi possível carregar o status da PR. A conexão GitHub pode estar quebrada.",
  "thread.gitTab.into": "em {base}",
  "thread.gitTab.loadingPrState": "Carregando status da PR…",
  "thread.gitTab.merged": "✓ Mesclado",
  "thread.gitTab.noBranchSelected": "Nenhuma branch selecionada.",
  "thread.gitTab.noPrYet":
    'Esta branch não tem uma pull request aberta. Clique em "Enviar para revisão" no cabeçalho para abrir uma; o agente rascunhará o título e resumo do estado atual da branch.',
  "thread.gitTab.notLinkedToGithub":
    "Este virtualmcp não está vinculado a um repositório GitHub.",
  "thread.gitTab.openBranchOnGithub": "Abrir branch no GitHub",
  "thread.gitTab.openPrAriaLabel": "Abrir PR #{number} no GitHub",
  "thread.gitTab.pickBranchForPrStatus":
    "Escolha uma branch no cabeçalho para ver o status da PR.",
  "thread.gitTab.prNumber": "PR #{number}",
  "thread.headerActions.addressFeedback": "Tratar feedback",
  "thread.headerActions.awaitingReview": "Aguardando revisão",
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
  "thread.headerActions.fixTests": "Corrigir testes",
  "thread.headerActions.githubConnectionRemoved":
    "A conexão do GitHub foi removida — revincula o repositório em Configurações para salvar alterações",
  "thread.headerActions.loading": "Carregando…",
  "thread.headerActions.loadingBranch": "Carregando branch…",
  "thread.headerActions.loadingBranchTooltip":
    "Carregando branch e status do pull request",
  "thread.headerActions.markReady": "Marcar como pronto",
  "thread.headerActions.markDraftReadyTooltip":
    "Marcar PR rascunho como pronto para revisão",
  "thread.headerActions.openNewPrTooltip":
    "Abrir um novo PR com os últimos commits",
  "thread.headerActions.openPrForBranchTooltip":
    "Abrir um PR para {branch} → {base}",
  "thread.headerActions.prMergedTooltip": "PR #{prNumber} mesclado em {base}",
  "thread.headerActions.publish": "Publicar",
  "thread.headerActions.publishDirectlySkipReview":
    "Publicar diretamente, pulando a revisão",
  "thread.headerActions.publishedPr": "PR #{prNumber} publicado",
  "thread.headerActions.sync": "Sincronizar",
  "thread.headerActions.syncTooltip":
    "Salva suas alterações e atualiza com o trabalho de todos",
  "thread.headerActions.published": "Publicado",
  "thread.headerActions.publishNeedsReview":
    "Esta alteração precisa de revisão antes de publicar.",
  "thread.headerActions.publishToProduction": "Publicar em produção",
  "thread.headerActions.pushAndOpenPrTooltip":
    "Enviar e abrir um PR para {branch} → {base}",
  "thread.headerActions.pushLocalCommitsTooltip":
    "Enviar commits locais para o PR #{prNumber}",
  "thread.headerActions.reconnectGithub": "Reconectar GitHub",
  "thread.headerActions.reviewingChanges": "Revisando alterações…",
  "thread.headerActions.saving": "Salvando…",
  "thread.headerActions.reopen": "Reabrir",
  "thread.headerActions.reopenPrTooltip": "Reabrir PR #{prNumber}",
  "thread.headerActions.resolveConflictsTooltip":
    "Resolver conflitos com {base} antes de mesclar",
  "thread.headerActions.runningTests": "Executando testes…",
  "thread.headerActions.squashMergeTooltip":
    "Squash-merge do PR #{prNumber} em {base}",
  "thread.headerActions.startingSandbox": "Preparando ambiente…",
  "thread.headerActions.submitForReview": "Enviar para revisão",
  "thread.headerActions.switchingTo": "Mudando para {branch}…",
  "thread.headerActions.syncWith": "Sincronizar com {base}",
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
  "thread.headerActions.waitingOnChecksTooltip":
    "Aguardando {count} verificação(ões) terminar",
  "thread.mergeSplitButton.moreActionsAriaLabel": "Mais ações",
  "thread.mergeSplitButton.review": "Revisar",
  "thread.openInBoardButton.openTaskAriaLabel": "Abrir tarefa no quadro",
  "thread.openInBoardButton.openTaskInBoard": "Abrir tarefa no quadro",
  "thread.publishDialog.allChangesDiscarded":
    "Todas as alterações foram descartadas",
  "thread.publishDialog.branchLabel": "Branch:",
  "thread.publishDialog.cancel": "Cancelar",
  "thread.publishDialog.change": "alteração",
  "thread.publishDialog.changes": "alterações",
  "thread.publishDialog.changesFrom": "Alterações de {branch}",
  "thread.publishDialog.changesTab": "Alterações",
  "thread.publishDialog.commitMessage": "Mensagem de commit",
  "thread.publishDialog.commitTitlePlaceholder": "Título do commit…",
  "thread.publishDialog.description": "Descrição",
  "thread.publishDialog.descriptionLabel": "Descrição",
  "thread.publishDialog.descriptionPlaceholder": "Descrição (opcional)…",
  "thread.publishDialog.discardAll": "Descartar tudo",
  "thread.publishDialog.discardConfirmMessage":
    "Descartar todas as alterações? Isso não pode ser desfeito.",
  "thread.publishDialog.discardedChanges":
    "Alterações descartadas para {filepath}",
  "thread.publishDialog.failedDiscardChanges": "Falha ao descartar alterações",
  "thread.publishDialog.failedLoad": "Falha ao carregar alterações.",
  "thread.publishDialog.failedLoadAfterReprovision":
    "Falha ao carregar alterações após reprovisionar a sandbox.",
  "thread.publishDialog.failedMergePullRequest":
    "Falha ao mesclar pull request",
  "thread.publishDialog.failedOpenPullRequest": "Falha ao abrir pull request",
  "thread.publishDialog.failedPublish": "Falha ao publicar",
  "thread.publishDialog.failedPushChanges": "Falha ao enviar alterações",
  "thread.publishDialog.failedRebase": "Falha ao rebasar para a base",
  "thread.publishDialog.failedSubmitForReview": "Falha ao enviar para revisão",
  "thread.publishDialog.generating": "Gerando…",
  "thread.publishDialog.inThisPr": "neste PR",
  "thread.publishDialog.loadingChanges": "Carregando alterações…",
  "thread.publishDialog.mergeFailed":
    "Alterações foram enviadas e PR #{prNumber} está aberto, mas a mesclagem falhou: {message}",
  "thread.publishDialog.opensPullRequestInto":
    "Abre um pull request para {baseBranch} para revisão.",
  "thread.publishDialog.publishedTo": "Publicado em {baseBranch}",
  "thread.publishDialog.publishNeedsReview":
    "Esta alteração precisa de revisão antes de publicar.",
  "thread.publishDialog.pullRequest": "Pull request",
  "thread.publishDialog.regenerate": "Regenerar",
  "thread.publishDialog.reviewingChanges": "Revisando alterações…",
  "thread.publishDialog.squashMergesInto":
    "{publishLabel} faz squash-merge para {baseBranch}.",
  "thread.publishDialog.submitForReview": "Enviar para revisão",
  "thread.publishDialog.submitForReviewButton": "Enviar para revisão",
  "thread.publishDialog.submittedForReview":
    "Pull request #{prNumber} enviado para revisão",
  "thread.publishDialog.title": "Título",
  "thread.publishDialog.toPublish": "para publicar",
  "thread.publishDialog.viewOnGithub": "Ver no GitHub",
  "thread.publishDialog.viewPr": "Ver PR",
  "thread.publishDialog.visitPreview": "Abrir o Preview",
} satisfies Record<keyof typeof threadEn, string>;
