import type { details as detailsEn } from "../en/details.ts";

export const details = {
  "details.connection.authFailed": "Falha na autentica\u00e7\u00e3o: {error}",
  "details.connection.authSuccess": "Autentica\u00e7\u00e3o bem-sucedida",
  "details.connection.backButton": "Voltar para conex\u00f5es",
  "details.connection.connectedBy": "Conectado por",
  "details.connection.connectionDisabled": "Conex\u00e3o desabilitada",
  "details.connection.connectionEnabled": "Conex\u00e3o habilitada",
  "details.connection.deleteButton": "Excluir",
  "details.connection.descriptionLabel": "Descri\u00e7\u00e3o",
  "details.connection.failedRemoveOAuth": "Falha ao remover OAuth: {error}",
  "details.connection.failedRemoveOAuthError": "Falha ao remover OAuth",
  "details.connection.failedUpdateConnection":
    "Falha ao atualizar conex\u00e3o",
  "details.connection.nameLabel": "Nome",
  "details.connection.notFoundDescription":
    "Esta conex\u00e3o pode ter sido exclu\u00edda ou voc\u00ea pode n\u00e3o ter acesso.",
  "details.connection.notFoundTitle": "Conex\u00e3o n\u00e3o encontrada",
  "details.connection.oauthRemoved":
    "OAuth removido. Agora voc\u00ea pode se autenticar novamente com uma conta diferente.",
  "details.connection.saveButton": "Salvar altera\u00e7\u00f5es",
  "details.connection.savingButton": "Salvando\u2026",
  "details.connection.settingsDescription":
    "Atualize URL, autentica\u00e7\u00e3o e outras configura\u00e7\u00f5es",
  "details.connection.undoButton": "Desfazer",
  "details.connectionActivity.activity": "Atividade",
  "details.connectionActivity.avgLatency": "Lat\u00eancia m\u00e9dia",
  "details.connectionActivity.errorRatePercentage":
    "{errorRate}% das chamadas falharam",
  "details.connectionActivity.errors": "Erros",
  "details.connectionActivity.noActivityInThisPeriod":
    "Nenhuma atividade neste per\u00edodo",
  "details.connectionActivity.toolCalls": "Chamadas de ferramenta",
  "details.connectionActivity.topErrors": "Principais erros",
  "details.connectionCapabilities.capabilities": "Capacidades",
  "details.connectionCapabilities.noCapabilitiesDiscovered":
    "Nenhuma capacidade descoberta ainda. A conex\u00e3o ainda pode estar se conectando.",
  "details.connectionCapabilities.noItemsAvailable":
    "Nenhum {item} dispon\u00edvel.",
  "details.connectionCapabilities.promptsTab": "Prompts",
  "details.connectionCapabilities.resourcesTab": "Recursos",
  "details.connectionCapabilities.toolsTab": "Ferramentas ({count})",
  "details.connectionCapabilities.uiTab": "UI",
  "details.connectionInstancesPanel.addInstance": "Adicionar inst\u00e2ncia",
  "details.connectionInstancesPanel.authorize": "Autorizar",
  "details.connectionInstancesPanel.configure": "Configurar",
  "details.connectionInstancesPanel.delete": "Excluir",
  "details.connectionInstancesPanel.disable": "Desativar",
  "details.connectionInstancesPanel.disabled": "Desativado",
  "details.connectionInstancesPanel.disabledError": "Desativado (erro)",
  "details.connectionInstancesPanel.enable": "Ativar",
  "details.connectionInstancesPanel.instance": "Inst\u00e2ncia",
  "details.connectionInstancesPanel.instances": "Inst\u00e2ncias",
  "details.connectionInstancesPanel.needsAuthorization":
    "Requer autoriza\u00e7\u00e3o",
  "details.connectionSidebar.arguments": "Argumentos",
  "details.connectionSidebar.argumentsPlaceholder": "arg1 arg2 --flag value",
  "details.connectionSidebar.authenticatedViaOAuth": "Autenticado via OAuth",
  "details.connectionSidebar.clearAndReplaceToken": "Limpar e substituir token",
  "details.connectionSidebar.command": "Comando",
  "details.connectionSidebar.commandPlaceholder": "node, bun, python...",
  "details.connectionSidebar.connection": "Conex\u00e3o",
  "details.connectionSidebar.createAPatAt": "Crie um PAT em",
  "details.connectionSidebar.customCommand": "Comando Personalizado",
  "details.connectionSidebar.enterAccessToken": "Digite o token de acesso...",
  "details.connectionSidebar.environmentVariables":
    "Vari\u00e1veis de Ambiente",
  "details.connectionSidebar.githubPersonalAccessToken":
    "Token de Acesso Pessoal do GitHub",
  "details.connectionSidebar.http": "HTTP",
  "details.connectionSidebar.npmPackage": "Pacote NPM",
  "details.connectionSidebar.npmPackagePlaceholder":
    "@perplexity-ai/mcp-server",
  "details.connectionSidebar.npxPackage": "Pacote NPX",
  "details.connectionSidebar.pasteYourGitHubPat": "Cole seu PAT do GitHub",
  "details.connectionSidebar.reauthenticate": "Reautenticar",
  "details.connectionSidebar.removeOAuth": "Remover OAuth",
  "details.connectionSidebar.spaceSeparatedArguments":
    "Argumentos separados por espa\u00e7o",
  "details.connectionSidebar.sse": "SSE",
  "details.connectionSidebar.token": "Token",
  "details.connectionSidebar.type": "Tipo",
  "details.connectionSidebar.urlPlaceholder": "https://example.com/mcp",
  "details.connectionSidebar.virtualMcp": "MCP Virtual",
  "details.connectionSidebar.virtualMcpDescription":
    "Esta conex\u00e3o referencia um MCP Virtual. Ferramentas e recursos s\u00e3o agregados dinamicamente das conex\u00f5es subjacentes do MCP Virtual.",
  "details.connectionSidebar.virtualMcpId": "ID do MCP Virtual",
  "details.connectionSidebar.websocket": "Websocket",
  "details.connectionSidebar.workingDirectory": "Diret\u00f3rio de Trabalho",
  "details.connectionSidebar.workingDirectoryPlaceholder":
    "/path/para/projeto (opcional)",
  "details.connectionUiTab.adjustSearchTerms":
    "Tente ajustar os termos de pesquisa",
  "details.connectionUiTab.noAppsAvailable": "Nenhum app dispon\u00edvel",
  "details.connectionUiTab.noAppsFound": "Nenhum app encontrado",
  "details.connectionUiTab.noInteractiveUis":
    "Esta conex\u00e3o ainda n\u00e3o possui ferramentas com UIs interativas.",
  "details.connectionUiTab.searchAppsPlaceholder": "Pesquisar apps...",
  "details.mcpConfigurationForm.connecting": "Conectando...",
  "details.mcpConfigurationForm.customConnection": "Conex\u00e3o Personalizada",
  "details.mcpConfigurationForm.failedToConnectMcp":
    "Falha ao conectar MCP: {message}",
  "details.mcpConfigurationForm.noConnectionsFound":
    "Nenhuma conex\u00e3o encontrada",
  "details.mcpConfigurationForm.selectPlaceholder": "Selecionar {title}...",
  "details.prompt.bodyPlaceholder": "Escreva a mensagem do prompt\u2026",
  "details.prompt.description": "Descri\u00e7\u00e3o",
  "details.prompt.descriptionPlaceholder":
    "Adicione uma descri\u00e7\u00e3o\u2026",
  "details.prompt.details": "Detalhes",
  "details.prompt.message": "Mensagem",
  "details.prompt.messageDescription":
    "Isso se torna a mensagem do usu\u00e1rio no prompt.",
  "details.prompt.missingConnectionDescription":
    "Informa\u00e7\u00f5es de conex\u00e3o ausentes na rota atual.",
  "details.prompt.notFoundDescription":
    "Este prompt pode ter sido exclu\u00eddo ou voc\u00ea pode n\u00e3o ter acesso a ele.",
  "details.prompt.notFoundTitle": "Prompt n\u00e3o encontrado",
  "details.prompt.title": "T\u00edtulo",
  "details.prompt.titlePlaceholder": "Prompt sem t\u00edtulo",
  "details.settingsTab.authenticationRequired":
    "Autentica\u00e7\u00e3o Obrigat\u00f3ria",
  "details.settingsTab.manualAuthenticationDescription":
    "Este servidor requer uma chave de API ou token que deve ser configurado manualmente. Verifique a documenta\u00e7\u00e3o do servidor para instru\u00e7\u00f5es sobre como obter credenciais.",
  "details.settingsTab.manualAuthenticationRequired":
    "Autentica\u00e7\u00e3o Manual Obrigat\u00f3ria",
  "details.settingsTab.noAdditionalConfigurationNeeded":
    "Nenhuma configura\u00e7\u00e3o adicional \u00e9 necess\u00e1ria. Tudo est\u00e1 pronto para come\u00e7ar.",
  "details.settingsTab.oauthAuthenticationDescription":
    "Esta conex\u00e3o requer autentica\u00e7\u00e3o OAuth para acessar recursos.",
  "details.settingsTab.serverAllSet": "Este servidor est\u00e1 pronto!",
  "details.settingsTab.serverError": "Erro no Servidor",
  "details.settingsTab.serverErrorDescription":
    "O servidor MCP est\u00e1 enfrentando problemas no momento. Tente novamente mais tarde ou verifique o status do servidor.",
  "details.settingsTab.viewReadme": "Ver README",
  "details.tool.cancel": "Cancelar",
  "details.tool.connectionNotFound": "Conex\u00e3o n\u00e3o encontrada",
  "details.tool.connectionNotFoundMessage":
    "Esta conex\u00e3o pode ter sido exclu\u00edda ou voc\u00ea pode n\u00e3o ter acesso a ela.",
  "details.tool.connections": "Conex\u00f5es",
  "details.tool.copiedToClipboard":
    "Copiado para a \u00e1rea de transfer\u00eancia",
  "details.tool.enter": "Insira {key}...",
  "details.tool.enterAsJson": "Insira {key} como JSON...",
  "details.tool.executeTool": "Executar Ferramenta",
  "details.tool.executionFailed": "Execu\u00e7\u00e3o Falhou",
  "details.tool.goBackToAuthenticate": "Voltar para autenticar",
  "details.tool.instance": "Inst\u00e2ncia",
  "details.tool.interactiveView": "Visualiza\u00e7\u00e3o interativa",
  "details.tool.jsonView": "Visualiza\u00e7\u00e3o JSON",
  "details.tool.loadingApp": "Carregando aplicativo...",
  "details.tool.noParametersRequired": "Nenhum par\u00e2metro obrigat\u00f3rio",
  "details.tool.parameters": "Par\u00e2metros",
  "details.tool.rawJsonExample": 'ex. { "foo": "bar" }',
  "details.tool.rawJsonInput": "Entrada JSON Bruta",
  "details.tool.required": "Obrigat\u00f3rio",
  "details.tool.result": "Resultado",
  "details.tool.runToolToSeeResults":
    "Execute a ferramenta para ver os resultados",
  "details.tool.selectTrueOrFalse": "Selecione verdadeiro ou falso...",
} satisfies Record<keyof typeof detailsEn, string>;
