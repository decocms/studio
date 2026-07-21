import type { registry as registryEn } from "../en/registry.ts";

export const registry = {
  "registry.brokenMcpList.connStatus": "conn",
  "registry.brokenMcpList.connectionLabel": "Conex\u00e3o",
  "registry.brokenMcpList.durationLabel": "Dura\u00e7\u00e3o",
  "registry.brokenMcpList.failedToolsHeader": "Ferramentas com Falha ({count})",
  "registry.brokenMcpList.fullError": "Erro Completo",
  "registry.brokenMcpList.no": "N\u00e3o",
  "registry.brokenMcpList.noBrokenMcps":
    "Nenhum MCP com problema nesta execu\u00e7\u00e3o. Tudo saud\u00e1vel! \u2713",
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
    "Fa\u00e7a upload de um arquivo CSV para importar em massa servidores MCP no registro.",
  "registry.csvImportDialog.doneButton": "Conclu\u00eddo",
  "registry.csvImportDialog.downloadTemplate": "Baixar modelo",
  "registry.csvImportDialog.emptyStateHint":
    "Escolha um arquivo CSV ou baixe o modelo para come\u00e7ar.",
  "registry.csvImportDialog.importButton": "Importar {count} item(ns)",
  "registry.csvImportDialog.importedCount":
    "Importados {count} item(ns) com sucesso",
  "registry.csvImportDialog.importingButton": "Importando...",
  "registry.csvImportDialog.itemsCount": "{count} itens",
  "registry.csvImportDialog.linePrefix": "Linha {line}:",
  "registry.csvImportDialog.preview": "Visualiza\u00e7\u00e3o",
  "registry.csvImportDialog.skippedCount": "{count} ignorados",
  "registry.csvImportDialog.tableIdHeader": "ID",
  "registry.csvImportDialog.tableNoValue": "N\u00e3o",
  "registry.csvImportDialog.tableNoneValue": "nenhum",
  "registry.csvImportDialog.tablePublicHeader": "P\u00fablico",
  "registry.csvImportDialog.tableTagsHeader": "Marcas",
  "registry.csvImportDialog.tableTitleHeader": "T\u00edtulo",
  "registry.csvImportDialog.tableUrlHeader": "URL remota",
  "registry.csvImportDialog.tableYesValue": "Sim",
  "registry.csvImportDialog.title": "Importar servidores MCP de CSV",
  "registry.deleteConfirmDialog.cancel": "Cancelar",
  "registry.deleteConfirmDialog.delete": "Deletar",
  "registry.deleteConfirmDialog.deleting": "Deletando...",
  "registry.deleteConfirmDialog.description":
    "Esta a\u00e7\u00e3o n\u00e3o pode ser desfeita. O item {title} ser\u00e1 removido permanentemente deste registro privado.",
  "registry.deleteConfirmDialog.title": "Deletar item do registro?",
  "registry.imageUpload.change": "Alterar",
  "registry.imageUpload.clickOrDragToUpload": "Clique ou arraste para enviar",
  "registry.imageUpload.dropImageHere": "Solte a imagem aqui",
  "registry.imageUpload.image": "Imagem",
  "registry.imageUpload.orPasteImageUrl": "Ou cole um URL de imagem",
  "registry.imageUpload.previewAlt": "Visualiza\u00e7\u00e3o",
  "registry.imageUpload.remove": "Remover",
  "registry.imageUpload.supportedFormats": "PNG, JPG, SVG at\u00e9 2MB",
  "registry.imageUpload.uploadingImage": "Enviando imagem...",
  "registry.imageUpload.urlPlaceholder": "https://example.com/logo.png",
  "registry.monitorConfiguration.aboutLabel": "Sobre {label}",
  "registry.monitorConfiguration.additionalTestContextHint":
    "Contexto de tempo de execu\u00e7\u00e3o adicional passado ao agente, como e-mails v\u00e1lidos, IDs de tenant ou entidades de teste conhecidas.",
  "registry.monitorConfiguration.additionalTestContextLabel":
    "Contexto de teste adicional (prompt)",
  "registry.monitorConfiguration.agentContextHelper":
    "Use este campo para dados reais necess\u00e1rios por algumas ferramentas (E-mail v\u00e1lido, IDs fixos, detalhes do ambiente de teste, etc).",
  "registry.monitorConfiguration.agentContextPlaceholder":
    'Exemplo: Use "my-user@company.com" como um E-mail v\u00e1lido para testes de compartilhamento/criar_permiss\u00e3o do Google Drive.',
  "registry.monitorConfiguration.defaultSystemPrompt":
    "prompt de sistema padr\u00e3o",
  "registry.monitorConfiguration.description":
    "Configure como o agente de QA de MCP valida entradas do registro.",
  "registry.monitorConfiguration.hideDefaultPrompt": "Ocultar",
  "registry.monitorConfiguration.includePendingRequests":
    "Incluir requisi\u00e7\u00f5es pendentes nos testes",
  "registry.monitorConfiguration.maxAgentStepsHint":
    "N\u00famero m\u00e1ximo de passos de racioc\u00ednio/ferramenta no modo Agentic.",
  "registry.monitorConfiguration.maxAgentStepsLabel":
    "M\u00e1ximo de passos do agente",
  "registry.monitorConfiguration.onFailureHint":
    "A\u00e7\u00e3o autom\u00e1tica a aplicar quando um MCP falha nos testes em uma execu\u00e7\u00e3o.",
  "registry.monitorConfiguration.onFailureLabel": "Em caso de falha",
  "registry.monitorConfiguration.onFailureNone": "N\u00e3o fazer nada",
  "registry.monitorConfiguration.onFailureRemoveAll":
    "Remover de tudo (p\u00fablica + privada)",
  "registry.monitorConfiguration.onFailureRemovePrivate":
    "Remover do registro privado",
  "registry.monitorConfiguration.onFailureRemovePublic":
    "Remover da loja p\u00fablica",
  "registry.monitorConfiguration.onFailureUnlisted":
    "Remover da loja (manter no registro)",
  "registry.monitorConfiguration.perMcpTimeoutHint":
    "Tempo total m\u00e1ximo permitido para validar um MCP.",
  "registry.monitorConfiguration.perMcpTimeoutLabel":
    "Tempo limite por MCP (ms)",
  "registry.monitorConfiguration.perToolTimeoutHint":
    "Tempo m\u00e1ximo permitido para cada chamada de ferramenta individual.",
  "registry.monitorConfiguration.perToolTimeoutLabel":
    "Tempo limite por ferramenta (ms)",
  "registry.monitorConfiguration.privateOnly": "Apenas privado",
  "registry.monitorConfiguration.publicOnly": "Apenas p\u00fablico",
  "registry.monitorConfiguration.publishRequestsHint":
    "Inclua requisi\u00e7\u00f5es de publica\u00e7\u00e3o pendentes em execu\u00e7\u00f5es de QA para valid\u00e1-las antes de publicar na loja.",
  "registry.monitorConfiguration.publishRequestsLabel":
    "Requisi\u00e7\u00f5es de publica\u00e7\u00e3o",
  "registry.monitorConfiguration.qaConfiguration":
    "Configura\u00e7\u00e3o de QA",
  "registry.monitorConfiguration.saveSettings":
    "Salvar configura\u00e7\u00f5es",
  "registry.monitorConfiguration.saved": "Salvo",
  "registry.monitorConfiguration.saving": "Salvando...",
  "registry.monitorConfiguration.testScopeHint":
    "Escolha se os testes devem ser executados para itens p\u00fablicos, privados ou ambos.",
  "registry.monitorConfiguration.testScopeLabel": "Escopo de teste",
  "registry.monitorConfiguration.unsavedChanges":
    "Mudan\u00e7as n\u00e3o salvas",
  "registry.monitorConfiguration.viewDefaultPrompt": "Visualizar",
  "registry.monitorConnectionsPanel.actionsFor": "A\u00e7\u00f5es para {title}",
  "registry.monitorConnectionsPanel.authError": "Erro: {error}",
  "registry.monitorConnectionsPanel.authenticated": "Autenticado",
  "registry.monitorConnectionsPanel.checking": "Verificando...",
  "registry.monitorConnectionsPanel.checkingAuth":
    "Verificando autentica\u00e7\u00e3o...",
  "registry.monitorConnectionsPanel.connected": "Conectado",
  "registry.monitorConnectionsPanel.connectionAuthenticated":
    '"{title}" autenticado!',
  "registry.monitorConnectionsPanel.connectionReachable":
    '"{title}" est\u00e1 acess\u00edvel. Voc\u00ea pode autenticar novamente se necess\u00e1rio.',
  "registry.monitorConnectionsPanel.connectionsSynced":
    "Conex\u00f5es sincronizadas (loja + solicita\u00e7\u00f5es pendentes)",
  "registry.monitorConnectionsPanel.couldNotReachConnection":
    'N\u00e3o foi poss\u00edvel alcan\u00e7ar "{title}". O MCP remoto pode estar inativo.',
  "registry.monitorConnectionsPanel.description1":
    "Detectamos automaticamente o tipo de autentica\u00e7\u00e3o. Use OAuth quando dispon\u00edvel, ou sempre cole um Token/Chave API para MCPs de autentica\u00e7\u00e3o manual.",
  "registry.monitorConnectionsPanel.description2":
    "Listar ferramentas sozinhas n\u00e3o implica status autenticado.",
  "registry.monitorConnectionsPanel.description3":
    "Os cart\u00f5es mostram o \u00edcone MCP, status de autentica\u00e7\u00e3o e os contadores de testes com falha mais recentes.",
  "registry.monitorConnectionsPanel.edit": "Editar",
  "registry.monitorConnectionsPanel.errorSavingToken":
    "Erro ao salvar token: {error}",
  "registry.monitorConnectionsPanel.failedCount":
    "{mcpCount} MCP com falha / {toolsCount} ferramentas com falha",
  "registry.monitorConnectionsPanel.failedToSaveAuthStatus":
    'Falha ao salvar status de autentica\u00e7\u00e3o para "{title}": {error}',
  "registry.monitorConnectionsPanel.failedToSaveOAuthTokens":
    'Falha ao salvar tokens OAuth para "{title}".',
  "registry.monitorConnectionsPanel.failedToUpdateVisibility":
    "Falha ao atualizar visibilidade",
  "registry.monitorConnectionsPanel.filterAll": "Todos",
  "registry.monitorConnectionsPanel.filterRequests": "Solicita\u00e7\u00f5es",
  "registry.monitorConnectionsPanel.filterStore": "Loja",
  "registry.monitorConnectionsPanel.hiddenInPrivate": "Oculto em privado",
  "registry.monitorConnectionsPanel.hideFromPrivateStore":
    "Ocultar da loja privada",
  "registry.monitorConnectionsPanel.hideFromPublicStore":
    "Ocultar da loja p\u00fablica",
  "registry.monitorConnectionsPanel.needsAuth": "Requer Autentica\u00e7\u00e3o",
  "registry.monitorConnectionsPanel.noConnectionsForFilter":
    'Nenhuma conex\u00e3o de QA para este filtro. Clique em "Sincronizar" para criar mapeamentos de itens da loja e solicita\u00e7\u00f5es pendentes.',
  "registry.monitorConnectionsPanel.noOAuthSupport":
    '"{title}" n\u00e3o suporta OAuth. Use o campo de Token para colar uma chave API.',
  "registry.monitorConnectionsPanel.notChecked": "N\u00e3o verificado",
  "registry.monitorConnectionsPanel.notPublic": "N\u00e3o p\u00fablico",
  "registry.monitorConnectionsPanel.oauth": "OAuth",
  "registry.monitorConnectionsPanel.oauthAvailable": "OAuth dispon\u00edvel",
  "registry.monitorConnectionsPanel.oauthConnected": "OAuth conectado",
  "registry.monitorConnectionsPanel.oauthFailed":
    'Falha na autentica\u00e7\u00e3o OAuth para "{title}": {error}',
  "registry.monitorConnectionsPanel.openingAuthWindow":
    'Abrindo janela de autentica\u00e7\u00e3o para "{title}"...',
  "registry.monitorConnectionsPanel.pasteApiTokenPlaceholder":
    "Cole token / chave API...",
  "registry.monitorConnectionsPanel.public": "P\u00fablico",
  "registry.monitorConnectionsPanel.reAuthOAuth": "Re-autenticar OAuth",
  "registry.monitorConnectionsPanel.reCheck": "Verificar novamente",
  "registry.monitorConnectionsPanel.registryItemNotFound":
    "Item do registro n\u00e3o encontrado para esta conex\u00e3o.",
  "registry.monitorConnectionsPanel.replaceToken": "Substituir token",
  "registry.monitorConnectionsPanel.request": "Solicita\u00e7\u00e3o",
  "registry.monitorConnectionsPanel.requestItemNoControls":
    "Item de solicita\u00e7\u00e3o (sem controles de visibilidade da loja)",
  "registry.monitorConnectionsPanel.save": "Salvar",
  "registry.monitorConnectionsPanel.serverError": "Erro de servidor",
  "registry.monitorConnectionsPanel.serverErrorConnection":
    'Erro de servidor para "{title}". O MCP remoto pode estar inativo.',
  "registry.monitorConnectionsPanel.showInBothStores": "Mostrar nas duas lojas",
  "registry.monitorConnectionsPanel.store": "Loja",
  "registry.monitorConnectionsPanel.sync": "Sincronizar",
  "registry.monitorConnectionsPanel.syncFailed":
    "Falha na sincroniza\u00e7\u00e3o: {error}",
  "registry.monitorConnectionsPanel.syncing": "Sincronizando...",
  "registry.monitorConnectionsPanel.title": "Conex\u00f5es de QA",
  "registry.monitorConnectionsPanel.tokenApiKeyDescription":
    "Token/Chave API (para MCPs que requerem autentica\u00e7\u00e3o manual)",
  "registry.monitorConnectionsPanel.tokenCannotBeEmpty":
    "O token n\u00e3o pode estar vazio.",
  "registry.monitorConnectionsPanel.tokenManualAuth":
    "Token/autentica\u00e7\u00e3o manual",
  "registry.monitorConnectionsPanel.tokenSaved": 'Token salvo para "{title}"!',
  "registry.monitorConnectionsPanel.visibilityOnlyForStore":
    "Os controles de visibilidade est\u00e3o dispon\u00edveis apenas para itens da loja.",
  "registry.monitorConnectionsPanel.visibilityUpdated":
    "Visibilidade atualizada",
  "registry.monitorDashboard.autoSelectLatestRun":
    "Selecionar automaticamente execu\u00e7\u00e3o mais recente",
  "registry.monitorDashboard.cancelButton": "Cancelar",
  "registry.monitorDashboard.cancelButtonDialog": "Cancelar",
  "registry.monitorDashboard.confirmStartDescription":
    "J\u00e1 h\u00e1 uma execu\u00e7\u00e3o em progresso{runId}. Iniciar outra execu\u00e7\u00e3o pode aumentar a carga do banco de dados e desacelerar ambas as execu\u00e7\u00f5es.",
  "registry.monitorDashboard.confirmStartTitle":
    "Iniciar outra execu\u00e7\u00e3o de teste?",
  "registry.monitorDashboard.connFailTitle": "Conex\u00e3o falhou",
  "registry.monitorDashboard.connOkTitle": "Conex\u00e3o OK",
  "registry.monitorDashboard.connectionLabel": "Conex\u00e3o:",
  "registry.monitorDashboard.currentQaRunDescription":
    "Inicie uma execu\u00e7\u00e3o completa de valida\u00e7\u00e3o de QA e acompanhe os resultados em tempo real.",
  "registry.monitorDashboard.currentQaRunTitle":
    "Execu\u00e7\u00e3o de QA Atual",
  "registry.monitorDashboard.errorLabel": "Erro",
  "registry.monitorDashboard.failedLabel": "Falhados",
  "registry.monitorDashboard.inputLabel": "Entrada",
  "registry.monitorDashboard.itemsTestedCount": "{tested}/{total} testados",
  "registry.monitorDashboard.modeAgentic": "Ag\u00eantico (modelo LLM)",
  "registry.monitorDashboard.modeBadge": "modo: {mode}",
  "registry.monitorDashboard.modeDescriptionAgentic":
    "Usa um modelo LLM para executar chamadas de ferramentas encadeadas e validar sa\u00eddas.",
  "registry.monitorDashboard.modeDescriptionHealthCheck":
    "Verifica apenas conectividade e listagem de ferramentas \u2014 nenhuma chamada de ferramenta \u00e9 feita.",
  "registry.monitorDashboard.modeDescriptionToolCall":
    "Chama cada ferramenta com entradas vazias para verificar se ela responde sem erros.",
  "registry.monitorDashboard.modeHealthCheck":
    "Verifica\u00e7\u00e3o de sa\u00fade",
  "registry.monitorDashboard.modeToolCall": "Chamada de ferramenta",
  "registry.monitorDashboard.no": "N\u00e3o",
  "registry.monitorDashboard.noResultsYetMessage":
    "Nenhum resultado ainda. Inicie uma execu\u00e7\u00e3o para ver logs em tempo real aqui.",
  "registry.monitorDashboard.noRunSelectedMessage":
    "Nenhuma execu\u00e7\u00e3o selecionada ainda. Inicie uma nova execu\u00e7\u00e3o para come\u00e7ar.",
  "registry.monitorDashboard.noTools": "0 ferramentas",
  "registry.monitorDashboard.noToolsFound":
    "Nenhuma ferramenta encontrada neste servidor.",
  "registry.monitorDashboard.noToolsLabel": "nenhuma ferramenta",
  "registry.monitorDashboard.outputLabel": "Sa\u00edda",
  "registry.monitorDashboard.passedLabel": "Aprovados",
  "registry.monitorDashboard.progressBadge":
    "progresso: {tested} de {total} MCPs",
  "registry.monitorDashboard.qaModeLabel": "Modo de QA",
  "registry.monitorDashboard.qaOnLabel": "QA em:",
  "registry.monitorDashboard.qaResultsLogDescription":
    "Sa\u00edda de teste em tempo real por MCP para a execu\u00e7\u00e3o selecionada.",
  "registry.monitorDashboard.qaResultsLogTitle":
    "Log de resultados de QA ({count})",
  "registry.monitorDashboard.qaRunHistoryLabel":
    "Hist\u00f3rico de execu\u00e7\u00e3o de QA (escolha uma execu\u00e7\u00e3o anterior)",
  "registry.monitorDashboard.runInProgressBadge":
    "Execu\u00e7\u00e3o em progresso: {runId}",
  "registry.monitorDashboard.runInProgressLabel":
    "execu\u00e7\u00e3o em progresso",
  "registry.monitorDashboard.skippedLabel": "Ignorados",
  "registry.monitorDashboard.startAnotherRunButton":
    "Iniciar outra execu\u00e7\u00e3o",
  "registry.monitorDashboard.startAnywayButton": "Iniciar mesmo assim",
  "registry.monitorDashboard.startQaRunButton":
    "Iniciar execu\u00e7\u00e3o de QA",
  "registry.monitorDashboard.startingButton": "Iniciando...",
  "registry.monitorDashboard.statusFailed": "Falhou",
  "registry.monitorDashboard.statusOk": "OK",
  "registry.monitorDashboard.toolsDiscoveredHealthCheck":
    "Ferramentas descobertas ({count}) - n\u00e3o testadas individualmente (modo de verifica\u00e7\u00e3o de sa\u00fade)",
  "registry.monitorDashboard.toolsFoundCount":
    "{count} ferramentas encontradas",
  "registry.monitorDashboard.toolsListedLabel": "Ferramentas listadas:",
  "registry.monitorDashboard.toolsTestedCount":
    "{tested}/{discovered} ferramentas testadas",
  "registry.monitorDashboard.toolsTestedDetails":
    "Ferramentas testadas: {passed} aprovadas, {failed} falhadas",
  "registry.monitorDashboard.totalLabel": "Total",
  "registry.monitorDashboard.yes": "Sim",
  "registry.monitorRunDetail.action": "a\u00e7\u00e3o",
  "registry.monitorRunDetail.actionTaken": "A\u00e7\u00e3o Realizada",
  "registry.monitorRunDetail.agentSummary": "Resumo do Agente",
  "registry.monitorRunDetail.conn": "conex",
  "registry.monitorRunDetail.connected": "Conectado",
  "registry.monitorRunDetail.connection": "Conex\u00e3o",
  "registry.monitorRunDetail.duration": "Dura\u00e7\u00e3o",
  "registry.monitorRunDetail.durationLabel": "Dura\u00e7\u00e3o",
  "registry.monitorRunDetail.error": "Erro",
  "registry.monitorRunDetail.errorMessage": "Mensagem de Erro",
  "registry.monitorRunDetail.failed": "Falhou",
  "registry.monitorRunDetail.filterAll": "Todos",
  "registry.monitorRunDetail.filterError": "Erro",
  "registry.monitorRunDetail.filterFailed": "Falhados",
  "registry.monitorRunDetail.filterNeedsAuth": "Requer Autentica\u00e7\u00e3o",
  "registry.monitorRunDetail.filterPassed": "Aprovados",
  "registry.monitorRunDetail.filterSkipped": "Ignorados",
  "registry.monitorRunDetail.finished": "Finalizada",
  "registry.monitorRunDetail.input": "Entrada",
  "registry.monitorRunDetail.no": "N\u00e3o",
  "registry.monitorRunDetail.noAdditionalDetails": "Sem detalhes adicionais.",
  "registry.monitorRunDetail.noResultsMatchFilter":
    "Nenhum resultado corresponde ao filtro atual.",
  "registry.monitorRunDetail.noTestResultsYet":
    "Sem resultados de testes ainda.",
  "registry.monitorRunDetail.outputPreview": "Pr\u00e9via de sa\u00edda",
  "registry.monitorRunDetail.passed": "Aprovadas",
  "registry.monitorRunDetail.refresh": "Atualizar",
  "registry.monitorRunDetail.result": "resultado(s)",
  "registry.monitorRunDetail.runDetail": "Detalhes da Execu\u00e7\u00e3o",
  "registry.monitorRunDetail.selectRunToInspect":
    "Selecione uma execu\u00e7\u00e3o para inspecionar detalhes.",
  "registry.monitorRunDetail.skipped": "Ignoradas",
  "registry.monitorRunDetail.started": "Iniciada",
  "registry.monitorRunDetail.tested": "Testadas",
  "registry.monitorRunDetail.toolResults":
    "Resultados de Ferramentas ({passed} aprovadas, {failed} falhadas)",
  "registry.monitorRunDetail.tools": "ferramentas",
  "registry.monitorRunDetail.toolsDiscovered":
    "Ferramentas descobertas ({count}) \u2014 n\u00e3o testadas individualmente (modo de verifica\u00e7\u00e3o de sa\u00fade)",
  "registry.monitorRunDetail.toolsFound": "ferramentas encontradas",
  "registry.monitorRunDetail.toolsListed": "ferramentas listadas",
  "registry.monitorRunDetail.toolsListedLabel": "Ferramentas Listadas",
  "registry.monitorRunDetail.total": "Total",
  "registry.monitorRunDetail.yesWithCount": "Sim ({count})",
  "registry.registryItemCard.actionsFor": "A\u00e7\u00f5es para {title}",
  "registry.registryItemCard.delete": "Excluir",
  "registry.registryItemCard.edit": "Editar",
  "registry.registryItemCard.markAsOfficial": "Marcar como Oficial",
  "registry.registryItemCard.markAsVerified": "Marcar como Verificado",
  "registry.registryItemCard.noDescriptionProvided":
    "Nenhuma descri\u00e7\u00e3o fornecida.",
  "registry.registryItemCard.official": "Oficial",
  "registry.registryItemCard.private": "Privado",
  "registry.registryItemCard.public": "P\u00fablico",
  "registry.registryItemCard.unmarkAsOfficial": "Desmarcar como Oficial",
  "registry.registryItemCard.unmarkAsVerified": "Desmarcar como Verificado",
  "registry.registryItemCard.verified": "Verificado",
  "registry.registryItemDialog.addMcpServer": "Adicionar servidor MCP",
  "registry.registryItemDialog.advanced": "Avan\u00e7ado",
  "registry.registryItemDialog.andMore": "+{count} mais",
  "registry.registryItemDialog.authRequiredMessage":
    "Este servidor requer autentica\u00e7\u00e3o. A conex\u00e3o \u00e9 v\u00e1lida, mas as ferramentas n\u00e3o podem ser listadas sem credenciais.",
  "registry.registryItemDialog.back": "Voltar",
  "registry.registryItemDialog.briefDescription":
    "Descri\u00e7\u00e3o breve deste servidor MCP",
  "registry.registryItemDialog.cancel": "Cancelar",
  "registry.registryItemDialog.category": "Categoria",
  "registry.registryItemDialog.clear": "limpar",
  "registry.registryItemDialog.content": "Conte\u00fado",
  "registry.registryItemDialog.create": "Criar",
  "registry.registryItemDialog.createCategory": 'Criar "{value}"',
  "registry.registryItemDialog.createTag": 'Criar "{value}"',
  "registry.registryItemDialog.curatedAndApproved":
    "Selecionado e aprovado pela deco.",
  "registry.registryItemDialog.description": "Descri\u00e7\u00e3o",
  "registry.registryItemDialog.descriptionMaxLength":
    "A descri\u00e7\u00e3o deve ter 1500 caracteres ou menos.",
  "registry.registryItemDialog.details": "Detalhes",
  "registry.registryItemDialog.discoverToolsFromUrl":
    "Descobrir ferramentas da URL",
  "registry.registryItemDialog.discoveringTools": "Descobrindo ferramentas...",
  "registry.registryItemDialog.editMcpServer": "Editar servidor MCP",
  "registry.registryItemDialog.essentials": "Essenciais",
  "registry.registryItemDialog.failedToUploadImage":
    "Falha ao fazer upload da imagem. Tente novamente.",
  "registry.registryItemDialog.imageUrlIsInvalid":
    "A URL da imagem \u00e9 inv\u00e1lida.",
  "registry.registryItemDialog.imageUrlMustBeHttps":
    "A URL da imagem deve ser http(s).",
  "registry.registryItemDialog.itemId": "ID do item:",
  "registry.registryItemDialog.link": "Link",
  "registry.registryItemDialog.madeAndHostedByServiceProvider":
    "Feito e hospedado pelo provedor de servi\u00e7o.",
  "registry.registryItemDialog.makeThisMcpVisible":
    "Torne este MCP vis\u00edvel na URL da loja p\u00fablica.",
  "registry.registryItemDialog.name": "Nome",
  "registry.registryItemDialog.nameIsRequired":
    "O nome \u00e9 obrigat\u00f3rio.",
  "registry.registryItemDialog.nameMustContainValidCharacters":
    "O nome deve conter caracteres v\u00e1lidos.",
  "registry.registryItemDialog.next": "Pr\u00f3ximo",
  "registry.registryItemDialog.official": "Oficial",
  "registry.registryItemDialog.ownerOptional": "Propriet\u00e1rio (opcional)",
  "registry.registryItemDialog.provider": "Provedor",
  "registry.registryItemDialog.providerIsRequired":
    "O provedor \u00e9 obrigat\u00f3rio.",
  "registry.registryItemDialog.public": "P\u00fablico",
  "registry.registryItemDialog.readme": "README",
  "registry.registryItemDialog.readmeMaxLength":
    "O README deve ter 50 000 caracteres ou menos.",
  "registry.registryItemDialog.readmeUrlIsInvalid":
    "A URL do README \u00e9 inv\u00e1lida.",
  "registry.registryItemDialog.readmeUrlMustBeHttps":
    "A URL do README deve ser http(s).",
  "registry.registryItemDialog.rediscoverTools": "Redescobrir ferramentas",
  "registry.registryItemDialog.remoteTypeMustBe":
    "O tipo remoto deve ser: http, sse ou stdio.",
  "registry.registryItemDialog.remoteUrl": "URL remota",
  "registry.registryItemDialog.remoteUrlIsInvalid":
    "A URL remota \u00e9 inv\u00e1lida.",
  "registry.registryItemDialog.remoteUrlMustBeHttps":
    "A URL remota deve ser http(s).",
  "registry.registryItemDialog.repositoryUrlIsInvalid":
    "A URL do reposit\u00f3rio \u00e9 inv\u00e1lida.",
  "registry.registryItemDialog.repositoryUrlMustBeHttps":
    "A URL do reposit\u00f3rio deve ser http(s).",
  "registry.registryItemDialog.repositoryUrlOptional":
    "URL do reposit\u00f3rio (opcional)",
  "registry.registryItemDialog.saveChanges": "Salvar altera\u00e7\u00f5es",
  "registry.registryItemDialog.saving": "Salvando...",
  "registry.registryItemDialog.selectOrCreateCategory":
    "Selecione ou crie uma categoria",
  "registry.registryItemDialog.shortDescription": "Descri\u00e7\u00e3o curta",
  "registry.registryItemDialog.shortDescriptionMaxLength":
    "A descri\u00e7\u00e3o curta deve ter 160 caracteres ou menos.",
  "registry.registryItemDialog.shortSummaryForStoreCard":
    "Resumo curto para o cart\u00e3o da loja",
  "registry.registryItemDialog.step1Description":
    "Configure a identidade, conex\u00e3o e descubra as ferramentas dispon\u00edveis.",
  "registry.registryItemDialog.step2Description":
    "Adicione descri\u00e7\u00f5es, categorias e tags para ajudar a descoberta.",
  "registry.registryItemDialog.step3Description":
    "Configure metadados opcionais, README e ferramentas.",
  "registry.registryItemDialog.tags": "Tags",
  "registry.registryItemDialog.teamCompanyOrPerson":
    "Equipe, empresa ou pessoa respons\u00e1vel",
  "registry.registryItemDialog.toolsDiscovered":
    "{count} ferramenta(ns) descoberta(s)",
  "registry.registryItemDialog.toolsLoaded":
    "{count} ferramenta(ns) carregada(s)",
  "registry.registryItemDialog.toolsWillEnrich":
    "Essas ferramentas enriquecer\u00e3o as descri\u00e7\u00f5es, tags e categorias geradas por IA na pr\u00f3xima etapa.",
  "registry.registryItemDialog.type": "Tipo",
  "registry.registryItemDialog.typeAndPressEnter":
    "Digite e pressione Enter ou v\u00edrgula",
  "registry.registryItemDialog.typeToSearchOrCreate":
    "Digite para pesquisar ou criar.",
  "registry.registryItemDialog.useValidIdFormat":
    "Use letras min\u00fasculas/n\u00fameros e separadores '/' ou '-'.",
  "registry.registryItemDialog.verified": "Verificado",
  "registry.registryItemsPage.actions": "A\u00e7\u00f5es",
  "registry.registryItemsPage.actionsFor": "A\u00e7\u00f5es para {title}",
  "registry.registryItemsPage.addFirstMcpItem":
    "Adicione seu primeiro item MCP para come\u00e7ar a construir seu cat\u00e1logo de registro privado.",
  "registry.registryItemsPage.addMcpServers": "Adicionar Servidores MCP",
  "registry.registryItemsPage.cards": "Cart\u00f5es",
  "registry.registryItemsPage.cardsViewAriaLabel":
    "Visualiza\u00e7\u00e3o em cart\u00f5es",
  "registry.registryItemsPage.categories": "Categorias",
  "registry.registryItemsPage.clearFilters": "Limpar filtros",
  "registry.registryItemsPage.delete": "Excluir",
  "registry.registryItemsPage.edit": "Editar",
  "registry.registryItemsPage.failedToDeleteItem": "Falha ao excluir item",
  "registry.registryItemsPage.failedToImportCsv": "Falha ao importar CSV",
  "registry.registryItemsPage.failedToSaveItem": "Falha ao salvar item",
  "registry.registryItemsPage.failedToUpdateItem": "Falha ao atualizar item",
  "registry.registryItemsPage.filters": "Filtros",
  "registry.registryItemsPage.icon": "\u00cdcone",
  "registry.registryItemsPage.id": "ID",
  "registry.registryItemsPage.importCsv": "Importar CSV",
  "registry.registryItemsPage.importedItems": "Importado(s) {count} item(ns)",
  "registry.registryItemsPage.items": "Itens",
  "registry.registryItemsPage.loadingItems": "Carregando itens...",
  "registry.registryItemsPage.loadingMoreItems": "Carregando mais itens...",
  "registry.registryItemsPage.markedAsOfficial": "Marcado como oficial",
  "registry.registryItemsPage.markedAsVerified": "Marcado como verificado",
  "registry.registryItemsPage.noCategoriesAvailable":
    "Nenhuma categoria dispon\u00edvel",
  "registry.registryItemsPage.noItemsFound": "Nenhum item encontrado",
  "registry.registryItemsPage.noMcpsInRegistry": "Nenhum MCP em seu registro",
  "registry.registryItemsPage.noTagsAvailable": "Nenhuma tag dispon\u00edvel",
  "registry.registryItemsPage.private": "Privado",
  "registry.registryItemsPage.public": "P\u00fablico",
  "registry.registryItemsPage.registryItemCreated": "Item do registro criado",
  "registry.registryItemsPage.registryItemDeleted":
    "Item do registro exclu\u00eddo",
  "registry.registryItemsPage.registryItemUpdated":
    "Item do registro atualizado",
  "registry.registryItemsPage.remoteUrl": "URL Remota",
  "registry.registryItemsPage.removedOfficialStatus": "Status oficial removido",
  "registry.registryItemsPage.removedVerifiedStatus":
    "Status verificado removido",
  "registry.registryItemsPage.searchPlaceholder":
    "Pesquisar por id, t\u00edtulo, descri\u00e7\u00e3o ou nome do servidor",
  "registry.registryItemsPage.table": "Tabela",
  "registry.registryItemsPage.tableViewAriaLabel":
    "Visualiza\u00e7\u00e3o em tabela",
  "registry.registryItemsPage.tags": "Tags",
  "registry.registryItemsPage.title": "T\u00edtulo",
  "registry.registryItemsPage.tryRemovingFilters":
    "Tente remover filtros ou alterar sua busca para encontrar MCPs correspondentes.",
  "registry.registryItemsPage.visibility": "Visibilidade",
  "registry.registryLayout.itemsTab": "Itens",
  "registry.registryLayout.qaTab": "QA",
  "registry.registryLayout.requestsTab": "Solicita\u00e7\u00f5es",
  "registry.registryLayout.settingsTab": "Configura\u00e7\u00f5es",
  "registry.registryMonitorPage.brokenMcps": "MCPs com falha",
  "registry.registryMonitorPage.tabConfiguration": "Configura\u00e7\u00e3o",
  "registry.registryMonitorPage.tabConnections": "Conex\u00f5es",
  "registry.registryMonitorPage.tabTests": "Testes",
  "registry.registryRequestsPage.approvePublishRequestDesc":
    "Isso adicionar\u00e1 {title} ao seu registro privado. O solicitante ser\u00e1 notificado da aprova\u00e7\u00e3o.",
  "registry.registryRequestsPage.approvePublishRequestTitle":
    "Aprovar solicita\u00e7\u00e3o de publica\u00e7\u00e3o?",
  "registry.registryRequestsPage.approveSelected": "Aprovar selecionados",
  "registry.registryRequestsPage.approveSelectedRequestsDesc":
    "Isso aprovar\u00e1 {count} solicita\u00e7\u00e3o(\u00f5es) e criar\u00e1 todos os aplicativos resultantes com a mesma configura\u00e7\u00e3o de visibilidade.",
  "registry.registryRequestsPage.approveSelectedRequestsTitle":
    "Aprovar solicita\u00e7\u00f5es selecionadas?",
  "registry.registryRequestsPage.approving": "Aprovando...",
  "registry.registryRequestsPage.bulkApproveFailed":
    "Aprova\u00e7\u00e3o em massa falhou. Itens selecionados foram mantidos para tentar novamente.",
  "registry.registryRequestsPage.bulkApprovePartial":
    "Aprovadas {approvedCount}. Falhadas {failedCount}. Itens com falha permanecer\u00e3o selecionados para tentar novamente.",
  "registry.registryRequestsPage.bulkApproveSuccess":
    "{approvedCount} solicita\u00e7\u00e3o(\u00f5es) aprovada(s) como {bulkVisibility}.",
  "registry.registryRequestsPage.buttonApprove": "Aprovar",
  "registry.registryRequestsPage.buttonCancel": "Cancelar",
  "registry.registryRequestsPage.buttonClose": "Fechar",
  "registry.registryRequestsPage.buttonDelete": "Deletar",
  "registry.registryRequestsPage.buttonReject": "Rejeitar",
  "registry.registryRequestsPage.buttonView": "Visualizar",
  "registry.registryRequestsPage.clearSelection": "Limpar sele\u00e7\u00e3o",
  "registry.registryRequestsPage.columnActions": "A\u00e7\u00f5es",
  "registry.registryRequestsPage.columnDate": "Data",
  "registry.registryRequestsPage.columnName": "Nome",
  "registry.registryRequestsPage.columnRequester": "Solicitante",
  "registry.registryRequestsPage.columnStatus": "Status",
  "registry.registryRequestsPage.columnTags": "Tags",
  "registry.registryRequestsPage.failedLoadRequests":
    "Falha ao carregar solicita\u00e7\u00f5es de publica\u00e7\u00e3o.",
  "registry.registryRequestsPage.itemAlreadyExists":
    "Um item com este ID j\u00e1 existe no registro. Delete ou renomeie primeiro.",
  "registry.registryRequestsPage.labelCategories": "Categorias",
  "registry.registryRequestsPage.labelDescription": "Descri\u00e7\u00e3o",
  "registry.registryRequestsPage.labelEmail": "E-mail",
  "registry.registryRequestsPage.labelREADME": "README",
  "registry.registryRequestsPage.labelRemoteURL": "URL Remota",
  "registry.registryRequestsPage.labelRequester": "Solicitante",
  "registry.registryRequestsPage.labelStatus": "Status",
  "registry.registryRequestsPage.labelSubmitted": "Enviado",
  "registry.registryRequestsPage.labelTags": "Tags",
  "registry.registryRequestsPage.loadingMoreRequests":
    "Carregando mais solicita\u00e7\u00f5es...",
  "registry.registryRequestsPage.loadingRequests":
    "Carregando solicita\u00e7\u00f5es...",
  "registry.registryRequestsPage.noApprovedRequests":
    "Nenhuma solicita\u00e7\u00e3o de publica\u00e7\u00e3o aprovada.",
  "registry.registryRequestsPage.noDescriptionProvided":
    "Nenhuma descri\u00e7\u00e3o fornecida.",
  "registry.registryRequestsPage.noPendingRequests":
    "Nenhuma solicita\u00e7\u00e3o de publica\u00e7\u00e3o pendente.",
  "registry.registryRequestsPage.noREADMEProvided": "Nenhum README fornecido.",
  "registry.registryRequestsPage.noRejectedRequests":
    "Nenhuma solicita\u00e7\u00e3o de publica\u00e7\u00e3o rejeitada.",
  "registry.registryRequestsPage.openREADMELink": "Abrir link README",
  "registry.registryRequestsPage.reasonForRejectionPlaceholder":
    "Motivo da rejei\u00e7\u00e3o...",
  "registry.registryRequestsPage.rejectPublishRequestDesc":
    "Esta solicita\u00e7\u00e3o ser\u00e1 movida para status rejeitado. Voc\u00ea pode deixar notas opcionais para contexto.",
  "registry.registryRequestsPage.rejectPublishRequestTitle":
    "Rejeitar solicita\u00e7\u00e3o de publica\u00e7\u00e3o?",
  "registry.registryRequestsPage.rejecting": "Rejeitando...",
  "registry.registryRequestsPage.requestApprovedAndAdded":
    "Solicita\u00e7\u00e3o aprovada e adicionada ao registro",
  "registry.registryRequestsPage.requestDeleted":
    "Solicita\u00e7\u00e3o deletada",
  "registry.registryRequestsPage.requestDetails":
    "Detalhes da solicita\u00e7\u00e3o",
  "registry.registryRequestsPage.requestRejected":
    "Solicita\u00e7\u00e3o rejeitada",
  "registry.registryRequestsPage.requestsToPublish":
    "Solicita\u00e7\u00f5es para Publicar",
  "registry.registryRequestsPage.reviewMetadataDescription":
    "Revise todos os metadados enviados pelo solicitante antes de aprovar.",
  "registry.registryRequestsPage.reviewerNotes": "Notas do revisor (opcional)",
  "registry.registryRequestsPage.selectAll": "Selecionar tudo",
  "registry.registryRequestsPage.selected": "Selecionado",
  "registry.registryRequestsPage.selectedCount":
    "{selectedCount} selecionado(s)",
  "registry.registryRequestsPage.sortAlphaAZ": "Alfab\u00e9tico (A-Z)",
  "registry.registryRequestsPage.sortAlphaZA": "Alfab\u00e9tico (Z-A)",
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
  "registry.registryRequestsPage.visibilityPublic": "P\u00fablico",
  "registry.registrySettingsPage.apiKeyGenerated":
    "Chave de API gerada. Copie agora \u2014 n\u00e3o ser\u00e1 mostrada novamente!",
  "registry.registrySettingsPage.apiKeyRevoked": "Chave de API revogada",
  "registry.registrySettingsPage.apiKeys": "Chaves de API",
  "registry.registrySettingsPage.cancel": "Cancelar",
  "registry.registrySettingsPage.configureNameIcon":
    "Configure o nome e o \u00edcone exibidos no seletor de lojas.",
  "registry.registrySettingsPage.failedGenerateApiKey":
    "Falha ao gerar chave de API",
  "registry.registrySettingsPage.failedRevokeApiKey":
    "Falha ao revogar chave de API",
  "registry.registrySettingsPage.failedUploadIcon":
    "Falha ao enviar \u00edcone. Tente novamente.",
  "registry.registrySettingsPage.generate": "Gerar",
  "registry.registrySettingsPage.keyName": "Nome da chave",
  "registry.registrySettingsPage.keyNamePlaceholder": "ex: Pipeline CI/CD",
  "registry.registrySettingsPage.maxRequests":
    "M\u00e1ximo de solicita\u00e7\u00f5es",
  "registry.registrySettingsPage.maxRequestsPlaceholder": "100",
  "registry.registrySettingsPage.name": "Nome",
  "registry.registrySettingsPage.namePlaceholder": "Registro Privado",
  "registry.registrySettingsPage.newKeyRefreshing":
    "Nova chave (atualizando lista...)",
  "registry.registrySettingsPage.perHour": "Por hora",
  "registry.registrySettingsPage.perMinute": "Por minuto",
  "registry.registrySettingsPage.publicItem": "item p\u00fablico",
  "registry.registrySettingsPage.publicItems": "itens p\u00fablicos",
  "registry.registrySettingsPage.publicRegistry": "Registro P\u00fablico",
  "registry.registrySettingsPage.publicRegistryDescription":
    "URL p\u00fablica para consumir este registro como um MCP.",
  "registry.registrySettingsPage.publishRequests":
    "Solicita\u00e7\u00f5es de Publica\u00e7\u00e3o",
  "registry.registrySettingsPage.publishRequestsDescription":
    "Permita que usu\u00e1rios externos enviem servidores MCP para an\u00e1lise.",
  "registry.registrySettingsPage.rateLimit": "Limite de Taxa",
  "registry.registrySettingsPage.rateLimitHelp":
    "Limite de solicita\u00e7\u00f5es de publica\u00e7\u00e3o por organiza\u00e7\u00e3o por janela de tempo.",
  "registry.registrySettingsPage.registryIdentity": "Identidade do Registro",
  "registry.registrySettingsPage.requireApiToken": "Exigir Token de API",
  "registry.registrySettingsPage.requireApiTokenHelp":
    "Solicita\u00e7\u00f5es sem um token v\u00e1lido ser\u00e3o rejeitadas.",
  "registry.registrySettingsPage.revokeApiKeyDescription":
    'Esta a\u00e7\u00e3o n\u00e3o pode ser desfeita. A chave{keyName ? ` "{keyName}"` : ""} deixar\u00e1 de funcionar imediatamente.',
  "registry.registrySettingsPage.revokeApiKeyTitle": "Revogar chave de API?",
  "registry.registrySettingsPage.revokeKey": "Revogar chave",
  "registry.registrySettingsPage.revoking": "Revogando...",
  "registry.registrySettingsPage.storeVisibility": "Visibilidade da Loja",
  "registry.registrySettingsPage.storeVisibilityDescription":
    "Escolha o que aparece quando os usu\u00e1rios navegam neste registro na Loja.",
  "registry.registrySettingsPage.storeVisibilityHelp":
    "Ativado: mostrar apenas aplicativos privados. Desativado: mostrar aplicativos p\u00fablicos e privados juntos.",
  "registry.registrySettingsPage.window": "Janela",
  "registry.toolsEditor.autoDiscover": "Descoberta autom\u00e1tica",
  "registry.toolsEditor.clear": "Limpar",
  "registry.toolsEditor.discoveredSuccess":
    "Descoberta de {count} ferramenta(s) realizada com sucesso.",
  "registry.toolsEditor.discovering": "Descobrindo...",
  "registry.toolsEditor.emptyHintWithUrl":
    'Clique em "Descoberta autom\u00e1tica" para carregar ferramentas do servidor MCP.',
  "registry.toolsEditor.emptyHintWithoutUrl":
    "Adicione uma URL remota primeiro, depois as ferramentas podem ser descobertas automaticamente.",
  "registry.toolsEditor.refresh": "Atualizar",
  "registry.toolsEditor.tools": "Ferramentas",
} satisfies Record<keyof typeof registryEn, string>;
