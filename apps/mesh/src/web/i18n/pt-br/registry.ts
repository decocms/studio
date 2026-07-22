import type { registry as registryEn } from "../en/registry.ts";

export const registry = {
  "registry.brokenMcpList.connStatus": "conn",
  "registry.brokenMcpList.connectionLabel": "Conexão",
  "registry.brokenMcpList.durationLabel": "Duração",
  "registry.brokenMcpList.failedToolsHeader": "Ferramentas com Falha ({count})",
  "registry.brokenMcpList.fullError": "Erro Completo",
  "registry.brokenMcpList.no": "Não",
  "registry.brokenMcpList.noBrokenMcps":
    "Nenhum MCP com problema nesta execução. Tudo saudável! ✓",
  "registry.brokenMcpList.passingTools": "Ferramentas Passando",
  "registry.brokenMcpList.statusFailed": "Com falha",
  "registry.brokenMcpList.statusOk": "OK",
  "registry.brokenMcpList.toolsFailed": "{count} ferramenta(s) com falha",
  "registry.brokenMcpList.toolsListed": "ferramentas listadas",
  "registry.brokenMcpList.toolsListedLabel": "Ferramentas Listadas",
  "registry.brokenMcpList.yes": "Sim",
  "registry.csvImportDialog.cancelButton": "Cancelar",
  "registry.csvImportDialog.changeFile": "Alterar arquivo",
  "registry.csvImportDialog.chooseCsvFile": "Escolher arquivo CSV",
  "registry.csvImportDialog.description":
    "Faça upload de um arquivo CSV para importar em massa servidores MCP no registro.",
  "registry.csvImportDialog.doneButton": "Concluído",
  "registry.csvImportDialog.downloadTemplate": "Baixar modelo",
  "registry.csvImportDialog.emptyStateHint":
    "Escolha um arquivo CSV ou baixe o modelo para começar.",
  "registry.csvImportDialog.importButton": "Importar {count} item(ns)",
  "registry.csvImportDialog.importedCount":
    "Importados {count} item(ns) com sucesso",
  "registry.csvImportDialog.importingButton": "Importando...",
  "registry.csvImportDialog.itemsCount": "{count} itens",
  "registry.csvImportDialog.linePrefix": "Linha {line}:",
  "registry.csvImportDialog.preview": "Visualização",
  "registry.csvImportDialog.skippedCount": "{count} ignorados",
  "registry.csvImportDialog.tableIdHeader": "ID",
  "registry.csvImportDialog.tableNoValue": "Não",
  "registry.csvImportDialog.tableNoneValue": "nenhum",
  "registry.csvImportDialog.tablePublicHeader": "Público",
  "registry.csvImportDialog.tableTagsHeader": "Marcas",
  "registry.csvImportDialog.tableTitleHeader": "Título",
  "registry.csvImportDialog.tableUrlHeader": "URL remota",
  "registry.csvImportDialog.tableYesValue": "Sim",
  "registry.csvImportDialog.title": "Importar servidores MCP de CSV",
  "registry.deleteConfirmDialog.cancel": "Cancelar",
  "registry.deleteConfirmDialog.delete": "Deletar",
  "registry.deleteConfirmDialog.deleting": "Deletando...",
  "registry.deleteConfirmDialog.description":
    "Esta ação não pode ser desfeita. O item {title} será removido permanentemente deste registro privado.",
  "registry.deleteConfirmDialog.title": "Deletar item do registro?",
  "registry.imageUpload.change": "Alterar",
  "registry.imageUpload.clickOrDragToUpload": "Clique ou arraste para enviar",
  "registry.imageUpload.dropImageHere": "Solte a imagem aqui",
  "registry.imageUpload.image": "Imagem",
  "registry.imageUpload.orPasteImageUrl": "Ou cole um URL de imagem",
  "registry.imageUpload.previewAlt": "Visualização",
  "registry.imageUpload.remove": "Remover",
  "registry.imageUpload.supportedFormats": "PNG, JPG, SVG até 2MB",
  "registry.imageUpload.uploadingImage": "Enviando imagem...",
  "registry.imageUpload.urlPlaceholder": "https://example.com/logo.png",
  "registry.monitorConfiguration.aboutLabel": "Sobre {label}",
  "registry.monitorConfiguration.additionalTestContextHint":
    "Contexto de tempo de execução adicional passado ao agente, como e-mails válidos, IDs de tenant ou entidades de teste conhecidas.",
  "registry.monitorConfiguration.additionalTestContextLabel":
    "Contexto de teste adicional (prompt)",
  "registry.monitorConfiguration.agentContextHelper":
    "Use este campo para dados reais necessários por algumas ferramentas (E-mail válido, IDs fixos, detalhes do ambiente de teste, etc).",
  "registry.monitorConfiguration.agentContextPlaceholder":
    'Exemplo: Use "my-user@company.com" como um E-mail válido para testes de compartilhamento/criar_permissão do Google Drive.',
  "registry.monitorConfiguration.defaultSystemPrompt":
    "prompt de sistema padrão",
  "registry.monitorConfiguration.description":
    "Configure como o agente de QA de MCP valida entradas do registro.",
  "registry.monitorConfiguration.hideDefaultPrompt": "Ocultar",
  "registry.monitorConfiguration.includePendingRequests":
    "Incluir requisições pendentes nos testes",
  "registry.monitorConfiguration.maxAgentStepsHint":
    "Número máximo de passos de raciocínio/ferramenta no modo Agentic.",
  "registry.monitorConfiguration.maxAgentStepsLabel":
    "Máximo de passos do agente",
  "registry.monitorConfiguration.onFailureHint":
    "Ação automática a aplicar quando um MCP falha nos testes em uma execução.",
  "registry.monitorConfiguration.onFailureLabel": "Em caso de falha",
  "registry.monitorConfiguration.onFailureNone": "Não fazer nada",
  "registry.monitorConfiguration.onFailureRemoveAll":
    "Remover de tudo (pública + privada)",
  "registry.monitorConfiguration.onFailureRemovePrivate":
    "Remover do registro privado",
  "registry.monitorConfiguration.onFailureRemovePublic":
    "Remover da loja pública",
  "registry.monitorConfiguration.onFailureUnlisted":
    "Remover da loja (manter no registro)",
  "registry.monitorConfiguration.perMcpTimeoutHint":
    "Tempo total máximo permitido para validar um MCP.",
  "registry.monitorConfiguration.perMcpTimeoutLabel":
    "Tempo limite por MCP (ms)",
  "registry.monitorConfiguration.perToolTimeoutHint":
    "Tempo máximo permitido para cada chamada de ferramenta individual.",
  "registry.monitorConfiguration.perToolTimeoutLabel":
    "Tempo limite por ferramenta (ms)",
  "registry.monitorConfiguration.privateOnly": "Apenas privado",
  "registry.monitorConfiguration.publicOnly": "Apenas público",
  "registry.monitorConfiguration.publishRequestsHint":
    "Inclua requisições de publicação pendentes em execuções de QA para validá-las antes de publicar na loja.",
  "registry.monitorConfiguration.publishRequestsLabel":
    "Requisições de publicação",
  "registry.monitorConfiguration.qaConfiguration": "Configuração de QA",
  "registry.monitorConfiguration.saveSettings": "Salvar configurações",
  "registry.monitorConfiguration.saved": "Salvo",
  "registry.monitorConfiguration.saving": "Salvando...",
  "registry.monitorConfiguration.testScopeHint":
    "Escolha se os testes devem ser executados para itens públicos, privados ou ambos.",
  "registry.monitorConfiguration.testScopeLabel": "Escopo de teste",
  "registry.monitorConfiguration.unsavedChanges": "Mudanças não salvas",
  "registry.monitorConfiguration.viewDefaultPrompt": "Visualizar",
  "registry.monitorConnectionsPanel.actionsFor": "Ações para {title}",
  "registry.monitorConnectionsPanel.authError": "Erro: {error}",
  "registry.monitorConnectionsPanel.authenticated": "Autenticado",
  "registry.monitorConnectionsPanel.checking": "Verificando...",
  "registry.monitorConnectionsPanel.checkingAuth":
    "Verificando autenticação...",
  "registry.monitorConnectionsPanel.connected": "Conectado",
  "registry.monitorConnectionsPanel.connectionAuthenticated":
    '"{title}" autenticado!',
  "registry.monitorConnectionsPanel.connectionReachable":
    '"{title}" está acessível. Você pode autenticar novamente se necessário.',
  "registry.monitorConnectionsPanel.connectionsSynced":
    "Conexões sincronizadas (loja + solicitações pendentes)",
  "registry.monitorConnectionsPanel.couldNotReachConnection":
    'Não foi possível alcançar "{title}". O MCP remoto pode estar inativo.',
  "registry.monitorConnectionsPanel.description1":
    "Detectamos automaticamente o tipo de autenticação. Use OAuth quando disponível, ou sempre cole um Token/Chave API para MCPs de autenticação manual.",
  "registry.monitorConnectionsPanel.description2":
    "Listar ferramentas sozinhas não implica status autenticado.",
  "registry.monitorConnectionsPanel.description3":
    "Os cartões mostram o ícone MCP, status de autenticação e os contadores de testes com falha mais recentes.",
  "registry.monitorConnectionsPanel.edit": "Editar",
  "registry.monitorConnectionsPanel.errorSavingToken":
    "Erro ao salvar token: {error}",
  "registry.monitorConnectionsPanel.failedCount":
    "{mcpCount} MCP com falha / {toolsCount} ferramentas com falha",
  "registry.monitorConnectionsPanel.failedToSaveAuthStatus":
    'Falha ao salvar status de autenticação para "{title}": {error}',
  "registry.monitorConnectionsPanel.failedToSaveOAuthTokens":
    'Falha ao salvar tokens OAuth para "{title}".',
  "registry.monitorConnectionsPanel.failedToUpdateVisibility":
    "Falha ao atualizar visibilidade",
  "registry.monitorConnectionsPanel.filterAll": "Todos",
  "registry.monitorConnectionsPanel.filterRequests": "Solicitações",
  "registry.monitorConnectionsPanel.filterStore": "Loja",
  "registry.monitorConnectionsPanel.hiddenInPrivate": "Oculto em privado",
  "registry.monitorConnectionsPanel.hideFromPrivateStore":
    "Ocultar da loja privada",
  "registry.monitorConnectionsPanel.hideFromPublicStore":
    "Ocultar da loja pública",
  "registry.monitorConnectionsPanel.loadFailed":
    "Falha ao carregar conexões de QA.",
  "registry.monitorConnectionsPanel.needsAuth": "Requer Autenticação",
  "registry.monitorConnectionsPanel.noConnectionsForFilter":
    'Nenhuma conexão de QA para este filtro. Clique em "Sincronizar" para criar mapeamentos de itens da loja e solicitações pendentes.',
  "registry.monitorConnectionsPanel.noOAuthSupport":
    '"{title}" não suporta OAuth. Use o campo de Token para colar uma chave API.',
  "registry.monitorConnectionsPanel.notChecked": "Não verificado",
  "registry.monitorConnectionsPanel.notPublic": "Não público",
  "registry.monitorConnectionsPanel.oauth": "OAuth",
  "registry.monitorConnectionsPanel.oauthAvailable": "OAuth disponível",
  "registry.monitorConnectionsPanel.oauthConnected": "OAuth conectado",
  "registry.monitorConnectionsPanel.oauthFailed":
    'Falha na autenticação OAuth para "{title}": {error}',
  "registry.monitorConnectionsPanel.openingAuthWindow":
    'Abrindo janela de autenticação para "{title}"...',
  "registry.monitorConnectionsPanel.pasteApiTokenPlaceholder":
    "Cole token / chave API...",
  "registry.monitorConnectionsPanel.public": "Público",
  "registry.monitorConnectionsPanel.reAuthOAuth": "Re-autenticar OAuth",
  "registry.monitorConnectionsPanel.reCheck": "Verificar novamente",
  "registry.monitorConnectionsPanel.registryItemNotFound":
    "Item do registro não encontrado para esta conexão.",
  "registry.monitorConnectionsPanel.replaceToken": "Substituir token",
  "registry.monitorConnectionsPanel.request": "Solicitação",
  "registry.monitorConnectionsPanel.requestItemNoControls":
    "Item de solicitação (sem controles de visibilidade da loja)",
  "registry.monitorConnectionsPanel.save": "Salvar",
  "registry.monitorConnectionsPanel.serverError": "Erro de servidor",
  "registry.monitorConnectionsPanel.serverErrorConnection":
    'Erro de servidor para "{title}". O MCP remoto pode estar inativo.',
  "registry.monitorConnectionsPanel.showInBothStores": "Mostrar nas duas lojas",
  "registry.monitorConnectionsPanel.store": "Loja",
  "registry.monitorConnectionsPanel.sync": "Sincronizar",
  "registry.monitorConnectionsPanel.syncFailed":
    "Falha na sincronização: {error}",
  "registry.monitorConnectionsPanel.syncing": "Sincronizando...",
  "registry.monitorConnectionsPanel.title": "Conexões de QA",
  "registry.monitorConnectionsPanel.tokenApiKeyDescription":
    "Token/Chave API (para MCPs que requerem autenticação manual)",
  "registry.monitorConnectionsPanel.tokenCannotBeEmpty":
    "O token não pode estar vazio.",
  "registry.monitorConnectionsPanel.tokenManualAuth":
    "Token/autenticação manual",
  "registry.monitorConnectionsPanel.tokenSaved": 'Token salvo para "{title}"!',
  "registry.monitorConnectionsPanel.unknownError": "Erro desconhecido",
  "registry.monitorConnectionsPanel.visibilityOnlyForStore":
    "Os controles de visibilidade estão disponíveis apenas para itens da loja.",
  "registry.monitorConnectionsPanel.visibilityUpdated":
    "Visibilidade atualizada",
  "registry.monitorDashboard.autoSelectLatestRun":
    "Selecionar automaticamente execução mais recente",
  "registry.monitorDashboard.cancelButton": "Cancelar",
  "registry.monitorDashboard.cancelButtonDialog": "Cancelar",
  "registry.monitorDashboard.confirmStartDescription":
    "Já há uma execução em progresso{runId}. Iniciar outra execução pode aumentar a carga do banco de dados e desacelerar ambas as execuções.",
  "registry.monitorDashboard.confirmStartTitle":
    "Iniciar outra execução de teste?",
  "registry.monitorDashboard.connFailTitle": "Conexão falhou",
  "registry.monitorDashboard.connOkTitle": "Conexão OK",
  "registry.monitorDashboard.connectionLabel": "Conexão:",
  "registry.monitorDashboard.currentQaRunDescription":
    "Inicie uma execução completa de validação de QA e acompanhe os resultados em tempo real.",
  "registry.monitorDashboard.currentQaRunTitle": "Execução de QA Atual",
  "registry.monitorDashboard.errorLabel": "Erro",
  "registry.monitorDashboard.failedLabel": "Falhados",
  "registry.monitorDashboard.inputLabel": "Entrada",
  "registry.monitorDashboard.itemsTestedCount": "{tested}/{total} testados",
  "registry.monitorDashboard.modeAgentic": "Agêntico (modelo LLM)",
  "registry.monitorDashboard.modeBadge": "modo: {mode}",
  "registry.monitorDashboard.modeDescriptionAgentic":
    "Usa um modelo LLM para executar chamadas de ferramentas encadeadas e validar saídas.",
  "registry.monitorDashboard.modeDescriptionHealthCheck":
    "Verifica apenas conectividade e listagem de ferramentas — nenhuma chamada de ferramenta é feita.",
  "registry.monitorDashboard.modeDescriptionToolCall":
    "Chama cada ferramenta com entradas vazias para verificar se ela responde sem erros.",
  "registry.monitorDashboard.modeHealthCheck": "Verificação de saúde",
  "registry.monitorDashboard.modeToolCall": "Chamada de ferramenta",
  "registry.monitorDashboard.no": "Não",
  "registry.monitorDashboard.noResultsYetMessage":
    "Nenhum resultado ainda. Inicie uma execução para ver logs em tempo real aqui.",
  "registry.monitorDashboard.noRunSelectedMessage":
    "Nenhuma execução selecionada ainda. Inicie uma nova execução para começar.",
  "registry.monitorDashboard.noTools": "0 ferramentas",
  "registry.monitorDashboard.noToolsFound":
    "Nenhuma ferramenta encontrada neste servidor.",
  "registry.monitorDashboard.noToolsLabel": "nenhuma ferramenta",
  "registry.monitorDashboard.outputLabel": "Saída",
  "registry.monitorDashboard.passedLabel": "Aprovados",
  "registry.monitorDashboard.progressBadge":
    "progresso: {tested} de {total} MCPs",
  "registry.monitorDashboard.qaModeLabel": "Modo de QA",
  "registry.monitorDashboard.qaOnLabel": "QA em:",
  "registry.monitorDashboard.qaResultsLogDescription":
    "Saída de teste em tempo real por MCP para a execução selecionada.",
  "registry.monitorDashboard.qaResultsLogTitle":
    "Log de resultados de QA ({count})",
  "registry.monitorDashboard.qaRunHistoryLabel":
    "Histórico de execução de QA (escolha uma execução anterior)",
  "registry.monitorDashboard.runInProgressBadge":
    "Execução em progresso: {runId}",
  "registry.monitorDashboard.runInProgressLabel": "execução em progresso",
  "registry.monitorDashboard.skippedLabel": "Ignorados",
  "registry.monitorDashboard.startAnotherRunButton": "Iniciar outra execução",
  "registry.monitorDashboard.startAnywayButton": "Iniciar mesmo assim",
  "registry.monitorDashboard.startQaRunButton": "Iniciar execução de QA",
  "registry.monitorDashboard.startingButton": "Iniciando...",
  "registry.monitorDashboard.statusFailed": "Falhou",
  "registry.monitorDashboard.statusOk": "OK",
  "registry.monitorDashboard.toolsDiscoveredHealthCheck":
    "Ferramentas descobertas ({count}) - não testadas individualmente (modo de verificação de saúde)",
  "registry.monitorDashboard.toolsFoundCount":
    "{count} ferramentas encontradas",
  "registry.monitorDashboard.toolsListedLabel": "Ferramentas listadas:",
  "registry.monitorDashboard.toolsTestedCount":
    "{tested}/{discovered} ferramentas testadas",
  "registry.monitorDashboard.toolsTestedDetails":
    "Ferramentas testadas: {passed} aprovadas, {failed} falhadas",
  "registry.monitorDashboard.totalLabel": "Total",
  "registry.monitorDashboard.yes": "Sim",
  "registry.monitorRunDetail.action": "ação",
  "registry.monitorRunDetail.actionTaken": "Ação Realizada",
  "registry.monitorRunDetail.agentSummary": "Resumo do Agente",
  "registry.monitorRunDetail.conn": "conex",
  "registry.monitorRunDetail.connected": "Conectado",
  "registry.monitorRunDetail.connection": "Conexão",
  "registry.monitorRunDetail.duration": "Duração",
  "registry.monitorRunDetail.durationLabel": "Duração",
  "registry.monitorRunDetail.error": "Erro",
  "registry.monitorRunDetail.errorMessage": "Mensagem de Erro",
  "registry.monitorRunDetail.failed": "Falhou",
  "registry.monitorRunDetail.filterAll": "Todos",
  "registry.monitorRunDetail.filterError": "Erro",
  "registry.monitorRunDetail.filterFailed": "Falhados",
  "registry.monitorRunDetail.filterNeedsAuth": "Requer Autenticação",
  "registry.monitorRunDetail.filterPassed": "Aprovados",
  "registry.monitorRunDetail.filterSkipped": "Ignorados",
  "registry.monitorRunDetail.finished": "Finalizada",
  "registry.monitorRunDetail.input": "Entrada",
  "registry.monitorRunDetail.no": "Não",
  "registry.monitorRunDetail.noAdditionalDetails": "Sem detalhes adicionais.",
  "registry.monitorRunDetail.noResultsMatchFilter":
    "Nenhum resultado corresponde ao filtro atual.",
  "registry.monitorRunDetail.noTestResultsYet":
    "Sem resultados de testes ainda.",
  "registry.monitorRunDetail.outputPreview": "Prévia de saída",
  "registry.monitorRunDetail.passed": "Aprovadas",
  "registry.monitorRunDetail.refresh": "Atualizar",
  "registry.monitorRunDetail.result": "resultado(s)",
  "registry.monitorRunDetail.runDetail": "Detalhes da Execução",
  "registry.monitorRunDetail.selectRunToInspect":
    "Selecione uma execução para inspecionar detalhes.",
  "registry.monitorRunDetail.skipped": "Ignoradas",
  "registry.monitorRunDetail.started": "Iniciada",
  "registry.monitorRunDetail.tested": "Testadas",
  "registry.monitorRunDetail.toolResults":
    "Resultados de Ferramentas ({passed} aprovadas, {failed} falhadas)",
  "registry.monitorRunDetail.tools": "ferramentas",
  "registry.monitorRunDetail.toolsDiscovered":
    "Ferramentas descobertas ({count}) — não testadas individualmente (modo de verificação de saúde)",
  "registry.monitorRunDetail.toolsFound": "ferramentas encontradas",
  "registry.monitorRunDetail.toolsListed": "ferramentas listadas",
  "registry.monitorRunDetail.toolsListedLabel": "Ferramentas Listadas",
  "registry.monitorRunDetail.total": "Total",
  "registry.monitorRunDetail.yesWithCount": "Sim ({count})",
  "registry.registryItemCard.actionsFor": "Ações para {title}",
  "registry.registryItemCard.delete": "Excluir",
  "registry.registryItemCard.edit": "Editar",
  "registry.registryItemCard.markAsOfficial": "Marcar como Oficial",
  "registry.registryItemCard.markAsVerified": "Marcar como Verificado",
  "registry.registryItemCard.noDescriptionProvided":
    "Nenhuma descrição fornecida.",
  "registry.registryItemCard.official": "Oficial",
  "registry.registryItemCard.private": "Privado",
  "registry.registryItemCard.public": "Público",
  "registry.registryItemCard.unmarkAsOfficial": "Desmarcar como Oficial",
  "registry.registryItemCard.unmarkAsVerified": "Desmarcar como Verificado",
  "registry.registryItemCard.verified": "Verificado",
  "registry.registryItemDialog.addMcpServer": "Adicionar servidor MCP",
  "registry.registryItemDialog.advanced": "Avançado",
  "registry.registryItemDialog.andMore": "+{count} mais",
  "registry.registryItemDialog.authRequiredMessage":
    "Este servidor requer autenticação. A conexão é válida, mas as ferramentas não podem ser listadas sem credenciais.",
  "registry.registryItemDialog.back": "Voltar",
  "registry.registryItemDialog.briefDescription":
    "Descrição breve deste servidor MCP",
  "registry.registryItemDialog.cancel": "Cancelar",
  "registry.registryItemDialog.category": "Categoria",
  "registry.registryItemDialog.clear": "limpar",
  "registry.registryItemDialog.content": "Conteúdo",
  "registry.registryItemDialog.create": "Criar",
  "registry.registryItemDialog.createCategory": 'Criar "{value}"',
  "registry.registryItemDialog.createTag": 'Criar "{value}"',
  "registry.registryItemDialog.curatedAndApproved":
    "Selecionado e aprovado pela deco.",
  "registry.registryItemDialog.description": "Descrição",
  "registry.registryItemDialog.descriptionMaxLength":
    "A descrição deve ter 1500 caracteres ou menos.",
  "registry.registryItemDialog.details": "Detalhes",
  "registry.registryItemDialog.discoverToolsFromUrl":
    "Descobrir ferramentas da URL",
  "registry.registryItemDialog.discoveringTools": "Descobrindo ferramentas...",
  "registry.registryItemDialog.editMcpServer": "Editar servidor MCP",
  "registry.registryItemDialog.essentials": "Essenciais",
  "registry.registryItemDialog.failedToUploadImage":
    "Falha ao fazer upload da imagem. Tente novamente.",
  "registry.registryItemDialog.imageUrlIsInvalid":
    "A URL da imagem é inválida.",
  "registry.registryItemDialog.imageUrlMustBeHttps":
    "A URL da imagem deve ser http(s).",
  "registry.registryItemDialog.itemId": "ID do item:",
  "registry.registryItemDialog.link": "Link",
  "registry.registryItemDialog.madeAndHostedByServiceProvider":
    "Feito e hospedado pelo provedor de serviço.",
  "registry.registryItemDialog.makeThisMcpVisible":
    "Torne este MCP visível na URL da loja pública.",
  "registry.registryItemDialog.name": "Nome",
  "registry.registryItemDialog.nameIsRequired": "O nome é obrigatório.",
  "registry.registryItemDialog.nameMustContainValidCharacters":
    "O nome deve conter caracteres válidos.",
  "registry.registryItemDialog.next": "Próximo",
  "registry.registryItemDialog.official": "Oficial",
  "registry.registryItemDialog.ownerOptional": "Proprietário (opcional)",
  "registry.registryItemDialog.provider": "Provedor",
  "registry.registryItemDialog.providerIsRequired": "O provedor é obrigatório.",
  "registry.registryItemDialog.public": "Público",
  "registry.registryItemDialog.readme": "README",
  "registry.registryItemDialog.readmeMaxLength":
    "O README deve ter 50 000 caracteres ou menos.",
  "registry.registryItemDialog.readmeUrlIsInvalid":
    "A URL do README é inválida.",
  "registry.registryItemDialog.readmeUrlMustBeHttps":
    "A URL do README deve ser http(s).",
  "registry.registryItemDialog.rediscoverTools": "Redescobrir ferramentas",
  "registry.registryItemDialog.remoteTypeMustBe":
    "O tipo remoto deve ser: http, sse ou stdio.",
  "registry.registryItemDialog.remoteUrl": "URL remota",
  "registry.registryItemDialog.remoteUrlIsInvalid": "A URL remota é inválida.",
  "registry.registryItemDialog.remoteUrlMustBeHttps":
    "A URL remota deve ser http(s).",
  "registry.registryItemDialog.repositoryUrlIsInvalid":
    "A URL do repositório é inválida.",
  "registry.registryItemDialog.repositoryUrlMustBeHttps":
    "A URL do repositório deve ser http(s).",
  "registry.registryItemDialog.repositoryUrlOptional":
    "URL do repositório (opcional)",
  "registry.registryItemDialog.saveChanges": "Salvar alterações",
  "registry.registryItemDialog.saving": "Salvando...",
  "registry.registryItemDialog.selectOrCreateCategory":
    "Selecione ou crie uma categoria",
  "registry.registryItemDialog.shortDescription": "Descrição curta",
  "registry.registryItemDialog.shortDescriptionMaxLength":
    "A descrição curta deve ter 160 caracteres ou menos.",
  "registry.registryItemDialog.shortSummaryForStoreCard":
    "Resumo curto para o cartão da loja",
  "registry.registryItemDialog.step1Description":
    "Configure a identidade, conexão e descubra as ferramentas disponíveis.",
  "registry.registryItemDialog.step2Description":
    "Adicione descrições, categorias e tags para ajudar a descoberta.",
  "registry.registryItemDialog.step3Description":
    "Configure metadados opcionais, README e ferramentas.",
  "registry.registryItemDialog.tags": "Tags",
  "registry.registryItemDialog.teamCompanyOrPerson":
    "Equipe, empresa ou pessoa responsável",
  "registry.registryItemDialog.toolsDiscovered":
    "{count} ferramenta(ns) descoberta(s)",
  "registry.registryItemDialog.toolsLoaded":
    "{count} ferramenta(ns) carregada(s)",
  "registry.registryItemDialog.toolsWillEnrich":
    "Essas ferramentas enriquecerão as descrições, tags e categorias geradas por IA na próxima etapa.",
  "registry.registryItemDialog.type": "Tipo",
  "registry.registryItemDialog.typeAndPressEnter":
    "Digite e pressione Enter ou vírgula",
  "registry.registryItemDialog.typeToSearchOrCreate":
    "Digite para pesquisar ou criar.",
  "registry.registryItemDialog.useValidIdFormat":
    "Use letras minúsculas/números e separadores '/' ou '-'.",
  "registry.registryItemDialog.verified": "Verificado",
  "registry.registryItemsPage.actions": "Ações",
  "registry.registryItemsPage.actionsFor": "Ações para {title}",
  "registry.registryItemsPage.addFirstMcpItem":
    "Adicione seu primeiro item MCP para começar a construir seu catálogo de registro privado.",
  "registry.registryItemsPage.addMcpServers": "Adicionar Servidores MCP",
  "registry.registryItemsPage.cards": "Cartões",
  "registry.registryItemsPage.cardsViewAriaLabel": "Visualização em cartões",
  "registry.registryItemsPage.categories": "Categorias",
  "registry.registryItemsPage.clearFilters": "Limpar filtros",
  "registry.registryItemsPage.delete": "Excluir",
  "registry.registryItemsPage.edit": "Editar",
  "registry.registryItemsPage.failedToDeleteItem": "Falha ao excluir item",
  "registry.registryItemsPage.failedToImportCsv": "Falha ao importar CSV",
  "registry.registryItemsPage.failedToSaveItem": "Falha ao salvar item",
  "registry.registryItemsPage.failedToUpdateItem": "Falha ao atualizar item",
  "registry.registryItemsPage.filters": "Filtros",
  "registry.registryItemsPage.icon": "Ícone",
  "registry.registryItemsPage.id": "ID",
  "registry.registryItemsPage.importCsv": "Importar CSV",
  "registry.registryItemsPage.importedItems": "Importado(s) {count} item(ns)",
  "registry.registryItemsPage.items": "Itens",
  "registry.registryItemsPage.loadingItems": "Carregando itens...",
  "registry.registryItemsPage.loadingMoreItems": "Carregando mais itens...",
  "registry.registryItemsPage.markedAsOfficial": "Marcado como oficial",
  "registry.registryItemsPage.markedAsVerified": "Marcado como verificado",
  "registry.registryItemsPage.noCategoriesAvailable":
    "Nenhuma categoria disponível",
  "registry.registryItemsPage.noItemsFound": "Nenhum item encontrado",
  "registry.registryItemsPage.noMcpsInRegistry": "Nenhum MCP em seu registro",
  "registry.registryItemsPage.noTagsAvailable": "Nenhuma tag disponível",
  "registry.registryItemsPage.private": "Privado",
  "registry.registryItemsPage.public": "Público",
  "registry.registryItemsPage.registryItemCreated": "Item do registro criado",
  "registry.registryItemsPage.registryItemDeleted": "Item do registro excluído",
  "registry.registryItemsPage.registryItemUpdated":
    "Item do registro atualizado",
  "registry.registryItemsPage.remoteUrl": "URL Remota",
  "registry.registryItemsPage.removedOfficialStatus": "Status oficial removido",
  "registry.registryItemsPage.removedVerifiedStatus":
    "Status verificado removido",
  "registry.registryItemsPage.searchPlaceholder":
    "Pesquisar por id, título, descrição ou nome do servidor",
  "registry.registryItemsPage.table": "Tabela",
  "registry.registryItemsPage.tableViewAriaLabel": "Visualização em tabela",
  "registry.registryItemsPage.tags": "Tags",
  "registry.registryItemsPage.title": "Título",
  "registry.registryItemsPage.tryRemovingFilters":
    "Tente remover filtros ou alterar sua busca para encontrar MCPs correspondentes.",
  "registry.registryItemsPage.visibility": "Visibilidade",
  "registry.registryLayout.itemsTab": "Itens",
  "registry.registryLayout.qaTab": "QA",
  "registry.registryLayout.requestsTab": "Solicitações",
  "registry.registryLayout.settingsTab": "Configurações",
  "registry.registryMonitorPage.brokenMcps": "MCPs com falha",
  "registry.registryMonitorPage.tabConfiguration": "Configuração",
  "registry.registryMonitorPage.tabConnections": "Conexões",
  "registry.registryMonitorPage.tabTests": "Testes",
  "registry.registryRequestsPage.approvePublishRequestDesc":
    "Isso adicionará {title} ao seu registro privado. O solicitante será notificado da aprovação.",
  "registry.registryRequestsPage.approvePublishRequestTitle":
    "Aprovar solicitação de publicação?",
  "registry.registryRequestsPage.approveSelected": "Aprovar selecionados",
  "registry.registryRequestsPage.approveSelectedRequestsDesc":
    "Isso aprovará {count} solicitação(ões) e criará todos os aplicativos resultantes com a mesma configuração de visibilidade.",
  "registry.registryRequestsPage.approveSelectedRequestsTitle":
    "Aprovar solicitações selecionadas?",
  "registry.registryRequestsPage.approving": "Aprovando...",
  "registry.registryRequestsPage.bulkApproveFailed":
    "Aprovação em massa falhou. Itens selecionados foram mantidos para tentar novamente.",
  "registry.registryRequestsPage.bulkApprovePartial":
    "Aprovadas {approvedCount}. Falhadas {failedCount}. Itens com falha permanecerão selecionados para tentar novamente.",
  "registry.registryRequestsPage.bulkApproveSuccess":
    "{approvedCount} solicitação(ões) aprovada(s) como {bulkVisibility}.",
  "registry.registryRequestsPage.buttonApprove": "Aprovar",
  "registry.registryRequestsPage.buttonCancel": "Cancelar",
  "registry.registryRequestsPage.buttonClose": "Fechar",
  "registry.registryRequestsPage.buttonDelete": "Deletar",
  "registry.registryRequestsPage.buttonReject": "Rejeitar",
  "registry.registryRequestsPage.buttonView": "Visualizar",
  "registry.registryRequestsPage.clearSelection": "Limpar seleção",
  "registry.registryRequestsPage.columnActions": "Ações",
  "registry.registryRequestsPage.columnDate": "Data",
  "registry.registryRequestsPage.columnName": "Nome",
  "registry.registryRequestsPage.columnRequester": "Solicitante",
  "registry.registryRequestsPage.columnStatus": "Status",
  "registry.registryRequestsPage.columnTags": "Tags",
  "registry.registryRequestsPage.failedLoadRequests":
    "Falha ao carregar solicitações de publicação.",
  "registry.registryRequestsPage.itemAlreadyExists":
    "Um item com este ID já existe no registro. Delete ou renomeie primeiro.",
  "registry.registryRequestsPage.labelCategories": "Categorias",
  "registry.registryRequestsPage.labelDescription": "Descrição",
  "registry.registryRequestsPage.labelEmail": "E-mail",
  "registry.registryRequestsPage.labelREADME": "README",
  "registry.registryRequestsPage.labelRemoteURL": "URL Remota",
  "registry.registryRequestsPage.labelRequester": "Solicitante",
  "registry.registryRequestsPage.labelStatus": "Status",
  "registry.registryRequestsPage.labelSubmitted": "Enviado",
  "registry.registryRequestsPage.labelTags": "Tags",
  "registry.registryRequestsPage.loadingMoreRequests":
    "Carregando mais solicitações...",
  "registry.registryRequestsPage.loadingRequests": "Carregando solicitações...",
  "registry.registryRequestsPage.noApprovedRequests":
    "Nenhuma solicitação de publicação aprovada.",
  "registry.registryRequestsPage.noDescriptionProvided":
    "Nenhuma descrição fornecida.",
  "registry.registryRequestsPage.noPendingRequests":
    "Nenhuma solicitação de publicação pendente.",
  "registry.registryRequestsPage.noREADMEProvided": "Nenhum README fornecido.",
  "registry.registryRequestsPage.noRejectedRequests":
    "Nenhuma solicitação de publicação rejeitada.",
  "registry.registryRequestsPage.openREADMELink": "Abrir link README",
  "registry.registryRequestsPage.reasonForRejectionPlaceholder":
    "Motivo da rejeição...",
  "registry.registryRequestsPage.rejectPublishRequestDesc":
    "Esta solicitação será movida para status rejeitado. Você pode deixar notas opcionais para contexto.",
  "registry.registryRequestsPage.rejectPublishRequestTitle":
    "Rejeitar solicitação de publicação?",
  "registry.registryRequestsPage.rejecting": "Rejeitando...",
  "registry.registryRequestsPage.requestApprovedAndAdded":
    "Solicitação aprovada e adicionada ao registro",
  "registry.registryRequestsPage.requestDeleted": "Solicitação deletada",
  "registry.registryRequestsPage.requestDetails": "Detalhes da solicitação",
  "registry.registryRequestsPage.requestRejected": "Solicitação rejeitada",
  "registry.registryRequestsPage.requestsToPublish":
    "Solicitações para Publicar",
  "registry.registryRequestsPage.reviewMetadataDescription":
    "Revise todos os metadados enviados pelo solicitante antes de aprovar.",
  "registry.registryRequestsPage.reviewerNotes": "Notas do revisor (opcional)",
  "registry.registryRequestsPage.selectAll": "Selecionar tudo",
  "registry.registryRequestsPage.selected": "Selecionado",
  "registry.registryRequestsPage.selectedCount":
    "{selectedCount} selecionado(s)",
  "registry.registryRequestsPage.sortAlphaAZ": "Alfabético (A-Z)",
  "registry.registryRequestsPage.sortAlphaZA": "Alfabético (Z-A)",
  "registry.registryRequestsPage.sortCreatedNewest":
    "Criado em (mais recentes primeiro)",
  "registry.registryRequestsPage.sortCreatedOldest":
    "Criado em (mais antigos primeiro)",
  "registry.registryRequestsPage.statusApproved": "Aprovado",
  "registry.registryRequestsPage.statusPending": "Pendente",
  "registry.registryRequestsPage.statusRejected": "Rejeitado",
  "registry.registryRequestsPage.unknownError": "Erro desconhecido",
  "registry.registryRequestsPage.visibilityForAll":
    "Visibilidade para todos os selecionados",
  "registry.registryRequestsPage.visibilityPrivate": "Privado",
  "registry.registryRequestsPage.visibilityPublic": "Público",
  "registry.registrySettingsPage.apiKeyGenerated":
    "Chave de API gerada. Copie agora — não será mostrada novamente!",
  "registry.registrySettingsPage.apiKeyRevoked": "Chave de API revogada",
  "registry.registrySettingsPage.apiKeys": "Chaves de API",
  "registry.registrySettingsPage.cancel": "Cancelar",
  "registry.registrySettingsPage.configureNameIcon":
    "Configure o nome e o ícone exibidos no seletor de lojas.",
  "registry.registrySettingsPage.failedGenerateApiKey":
    "Falha ao gerar chave de API",
  "registry.registrySettingsPage.failedRevokeApiKey":
    "Falha ao revogar chave de API",
  "registry.registrySettingsPage.failedUploadIcon":
    "Falha ao enviar ícone. Tente novamente.",
  "registry.registrySettingsPage.generate": "Gerar",
  "registry.registrySettingsPage.keyName": "Nome da chave",
  "registry.registrySettingsPage.keyNamePlaceholder": "ex: Pipeline CI/CD",
  "registry.registrySettingsPage.maxRequests": "Máximo de solicitações",
  "registry.registrySettingsPage.maxRequestsPlaceholder": "100",
  "registry.registrySettingsPage.name": "Nome",
  "registry.registrySettingsPage.namePlaceholder": "Registro Privado",
  "registry.registrySettingsPage.newKeyRefreshing":
    "Nova chave (atualizando lista...)",
  "registry.registrySettingsPage.perHour": "Por hora",
  "registry.registrySettingsPage.perMinute": "Por minuto",
  "registry.registrySettingsPage.publicItem": "item público",
  "registry.registrySettingsPage.publicItems": "itens públicos",
  "registry.registrySettingsPage.publicRegistry": "Registro Público",
  "registry.registrySettingsPage.publicRegistryDescription":
    "URL pública para consumir este registro como um MCP.",
  "registry.registrySettingsPage.publishRequests": "Solicitações de Publicação",
  "registry.registrySettingsPage.publishRequestsDescription":
    "Permita que usuários externos enviem servidores MCP para análise.",
  "registry.registrySettingsPage.rateLimit": "Limite de Taxa",
  "registry.registrySettingsPage.rateLimitHelp":
    "Limite de solicitações de publicação por organização por janela de tempo.",
  "registry.registrySettingsPage.registryIdentity": "Identidade do Registro",
  "registry.registrySettingsPage.requireApiToken": "Exigir Token de API",
  "registry.registrySettingsPage.requireApiTokenHelp":
    "Solicitações sem um token válido serão rejeitadas.",
  "registry.registrySettingsPage.revokeApiKeyDescription":
    'Esta ação não pode ser desfeita. A chave{keyName ? ` "{keyName}"` : ""} deixará de funcionar imediatamente.',
  "registry.registrySettingsPage.revokeApiKeyTitle": "Revogar chave de API?",
  "registry.registrySettingsPage.revokeKey": "Revogar chave",
  "registry.registrySettingsPage.revoking": "Revogando...",
  "registry.registrySettingsPage.storeVisibility": "Visibilidade da Loja",
  "registry.registrySettingsPage.storeVisibilityDescription":
    "Escolha o que aparece quando os usuários navegam neste registro na Loja.",
  "registry.registrySettingsPage.storeVisibilityHelp":
    "Ativado: mostrar apenas aplicativos privados. Desativado: mostrar aplicativos públicos e privados juntos.",
  "registry.registrySettingsPage.window": "Janela",
  "registry.toolsEditor.autoDiscover": "Descoberta automática",
  "registry.toolsEditor.clear": "Limpar",
  "registry.toolsEditor.discoveredSuccess":
    "Descoberta de {count} ferramenta(s) realizada com sucesso.",
  "registry.toolsEditor.discovering": "Descobrindo...",
  "registry.toolsEditor.emptyHintWithUrl":
    'Clique em "Descoberta automática" para carregar ferramentas do servidor MCP.',
  "registry.toolsEditor.emptyHintWithoutUrl":
    "Adicione uma URL remota primeiro, depois as ferramentas podem ser descobertas automaticamente.",
  "registry.toolsEditor.refresh": "Atualizar",
  "registry.toolsEditor.tools": "Ferramentas",
} satisfies Record<keyof typeof registryEn, string>;
