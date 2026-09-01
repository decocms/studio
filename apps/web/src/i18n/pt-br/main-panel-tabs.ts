import type { mainPanelTabs as mainPanelTabsEn } from "../en/main-panel-tabs.ts";

export const mainPanelTabs = {
  "mainPanelTabs.automationTab.automationNotFound": "Automação não encontrada",
  "mainPanelTabs.automationTab.backToList": "Voltar para a lista",
  "mainPanelTabs.automationTab.last24hours": "Últimas 24 horas",
  "mainPanelTabs.automationTab.last30days": "Últimos 30 dias",
  "mainPanelTabs.automationTab.last7days": "Últimos 7 dias",
  "mainPanelTabs.automationTab.runs": "Execuções",
  "mainPanelTabs.automationTab.settings": "Configurações",
  "mainPanelTabs.blocksTabStates.emptyStateDescription":
    "Configure edição de conteúdo avançada para que qualquer pessoa possa atualizar páginas sem tocar em código.",
  "mainPanelTabs.blocksTabStates.emptyStateTitle":
    "Deseja editar este site com formulários fáceis de usar?",
  "mainPanelTabs.blocksTabStates.errorStateData":
    "Studio não conseguiu carregar os metadados de Blocos deste projeto.",
  "mainPanelTabs.blocksTabStates.errorStateSandbox":
    "A visualização do projeto não pôde ser iniciada. Tente novamente para disponibilizar Blocos.",
  "mainPanelTabs.blocksTabStates.errorStateTitle": "Blocos indisponíveis",
  "mainPanelTabs.blocksTabStates.retry": "Tentar novamente",
  "mainPanelTabs.blocksTabStates.setupContentEditing":
    "Configurar edição de conteúdo",
  "mainPanelTabs.codeTab.noSandboxToBrowse": "Nenhuma sandbox para navegar.",
  "mainPanelTabs.codeTab.openInCursor": "Abrir no Cursor",
  "mainPanelTabs.codeTab.openInVscode": "Abrir no VSCode",
  "mainPanelTabs.contentTab.connectGithubDescription":
    "Conecte um repositório do GitHub pela aba Configurações para habilitar Conteúdo.",
  "mainPanelTabs.contentTab.noContentToEdit": "Nenhum conteúdo para editar.",
  "mainPanelTabs.fileTab.close": "Fechar",
  "mainPanelTabs.fileTab.download": "Baixar",
  "mainPanelTabs.fileTab.fileNotAvailable":
    "Este arquivo não está mais disponível.",
  "mainPanelTabs.fileTab.openInNewTab": "Abrir em nova aba",
  "mainPanelTabs.hostingTab.title": "Hospedagem",
  "mainPanelTabs.hostingTab.subtitle": "Infraestrutura de {site}",
  "mainPanelTabs.hostingTab.deployments": "Implantações",
  "mainPanelTabs.hostingTab.env": "Variáveis de ambiente",
  "mainPanelTabs.hostingTab.redirects": "Redirecionamentos",
  "mainPanelTabs.hostingTab.loading": "Carregando…",
  "mainPanelTabs.hostingTab.noDeployments": "Nenhuma implantação ainda.",
  "mainPanelTabs.hostingTab.noEnv": "Nenhuma variável de ambiente definida.",
  "mainPanelTabs.hostingTab.codeVarsHint":
    "Do wrangler.jsonc (somente leitura) — edite no código. Uma variável acima com o mesmo nome as sobrescreve no deploy.",
  "mainPanelTabs.hostingTab.noRedirects":
    "Nenhum redirecionamento configurado.",
  "mainPanelTabs.hostingTab.noSiteTitle": "Nenhum site vinculado",
  "mainPanelTabs.hostingTab.noSiteDescription":
    "Este projeto ainda não está vinculado a um site hospedado.",
  "mainPanelTabs.hostingTab.deploymentsError":
    "Falha ao carregar as implantações",
  "mainPanelTabs.hostingTab.envError":
    "Falha ao carregar as variáveis de ambiente",
  "mainPanelTabs.hostingTab.redirectsError":
    "Falha ao carregar os redirecionamentos",
  "mainPanelTabs.hostingTab.colId": "ID",
  "mainPanelTabs.hostingTab.colStatus": "Status",
  "mainPanelTabs.hostingTab.colUrl": "URL",
  "mainPanelTabs.hostingTab.colCreated": "Criado em",
  "mainPanelTabs.hostingTab.colKey": "Chave",
  "mainPanelTabs.hostingTab.colValue": "Valor",
  "mainPanelTabs.hostingTab.colFrom": "De",
  "mainPanelTabs.hostingTab.colTo": "Para",
  "mainPanelTabs.hostingTab.colCommit": "Commit",
  "mainPanelTabs.hostingTab.colUpdated": "Atualizado",
  "mainPanelTabs.hostingTab.colName": "Nome",
  "mainPanelTabs.hostingTab.colType": "Tipo",
  "mainPanelTabs.hostingTab.live": "No ar",
  "mainPanelTabs.hostingTab.permanent": "301 permanente",
  "mainPanelTabs.hostingTab.temporary": "307 temporário",
  "mainPanelTabs.hostingTab.dnsSetup": "Configuração DNS",
  "mainPanelTabs.hostingTab.dnsSetupTitle": "DNS no registrador",
  "mainPanelTabs.hostingTab.dnsSetupDescription":
    "Para ativar este redirecionamento, adicione estes registros no seu provedor de DNS para {host}.",
  "mainPanelTabs.hostingTab.dnsRedirectIntent":
    "Isto faz {from} redirecionar para o destino assim que o DNS de {from} apontar para a Deco. Adicione os registros abaixo no seu registrador.",
  "mainPanelTabs.hostingTab.dnsActiveHint":
    "A Deco está servindo este redirecionamento (o DNS está apontando para cá).",
  "mainPanelTabs.hostingTab.dnsAwaitingHint":
    "Ainda não resolve para a Deco — adicione os registros abaixo; mudanças de DNS podem levar até algumas horas para propagar.",
  "mainPanelTabs.hostingTab.dnsColType": "Tipo",
  "mainPanelTabs.hostingTab.dnsColName": "Nome",
  "mainPanelTabs.hostingTab.dnsColValue": "Valor",
  "mainPanelTabs.hostingTab.dnsActive": "Ativo",
  "mainPanelTabs.hostingTab.dnsAwaiting": "Aguardando DNS",
  "mainPanelTabs.hostingTab.dnsCopy": "Copiar valor",
  "mainPanelTabs.hostingTab.dnsCopied": "Copiado",
  "mainPanelTabs.hostingTab.notConnectedTitle":
    "Hospedagem ainda não conectada",
  "mainPanelTabs.hostingTab.notConnectedDescription":
    "Os dados de hospedagem deste site aparecerão aqui quando a conexão com o control-plane estiver configurada.",
  // --- Ações interativas (escrita) ---
  "mainPanelTabs.hostingTab.cancel": "Cancelar",
  "mainPanelTabs.hostingTab.save": "Salvar",
  "mainPanelTabs.hostingTab.saving": "Salvando…",
  "mainPanelTabs.hostingTab.add": "Adicionar",
  // Implantação
  "mainPanelTabs.hostingTab.deploy": "Implantar",
  "mainPanelTabs.hostingTab.deploying": "Implantando…",
  "mainPanelTabs.hostingTab.deployConfirmTitle": "Reimplantar o commit atual?",
  "mainPanelTabs.hostingTab.deployConfirmDescription":
    "Reimplantar o commit de produção atual?",
  "mainPanelTabs.hostingTab.toastDeployQueued": "Implantação enfileirada",
  // Variáveis de ambiente
  "mainPanelTabs.hostingTab.addVariable": "Adicionar variável",
  "mainPanelTabs.hostingTab.envNamePlaceholder": "NOME",
  "mainPanelTabs.hostingTab.envValuePlaceholder": "valor",
  "mainPanelTabs.hostingTab.editValue": "Editar valor",
  "mainPanelTabs.hostingTab.deleteVariable": "Excluir variável",
  "mainPanelTabs.hostingTab.confirmDeleteVariableTitle": "Excluir variável?",
  "mainPanelTabs.hostingTab.confirmDeleteVariableDescription":
    "Excluir {name}? Isso atualiza o ambiente do site.",
  "mainPanelTabs.hostingTab.toastEnvSaved": "Variáveis de ambiente atualizadas",
  "mainPanelTabs.hostingTab.errorEnvNameRequired": "O nome é obrigatório",
  "mainPanelTabs.hostingTab.errorEnvNameDuplicate":
    "Já existe uma variável com esse nome",
  // Segredos
  "mainPanelTabs.hostingTab.secrets": "Segredos",
  "mainPanelTabs.hostingTab.secretsError": "Falha ao carregar os segredos",
  "mainPanelTabs.hostingTab.noSecrets": "Nenhum segredo definido.",
  "mainPanelTabs.hostingTab.addSecret": "Adicionar segredo",
  "mainPanelTabs.hostingTab.addSecretTitle": "Adicionar segredo",
  "mainPanelTabs.hostingTab.secretNamePlaceholder": "NOME",
  "mainPanelTabs.hostingTab.secretValuePlaceholder": "valor",
  "mainPanelTabs.hostingTab.secretValueHidden": "••••••",
  "mainPanelTabs.hostingTab.secretOnWorker": "No worker",
  "mainPanelTabs.hostingTab.secretScope": "Escopo",
  "mainPanelTabs.hostingTab.secretScopeRuntime": "Runtime",
  "mainPanelTabs.hostingTab.secretScopeBuild": "Build",
  "mainPanelTabs.hostingTab.secretScopeRuntimeHint":
    "Injetado em tempo de execução (o ambiente de runtime do site).",
  "mainPanelTabs.hostingTab.secretScopeBuildHint":
    "Montado apenas no build (ex.: token de registry privado) — nunca exposto em runtime.",
  "mainPanelTabs.hostingTab.deleteSecret": "Excluir segredo",
  "mainPanelTabs.hostingTab.confirmDeleteSecretTitle": "Excluir segredo?",
  "mainPanelTabs.hostingTab.confirmDeleteSecretDescription":
    "Excluir {name}? Isso o remove do site.",
  "mainPanelTabs.hostingTab.toastSecretSaved": "Segredo salvo",
  "mainPanelTabs.hostingTab.toastSecretDeleted": "Segredo excluído",
  "mainPanelTabs.hostingTab.errorSecretNameRequired": "O nome é obrigatório",
  "mainPanelTabs.hostingTab.errorSecretValueRequired": "O valor é obrigatório",
  // Redirecionamentos
  "mainPanelTabs.hostingTab.addRedirect": "Adicionar redirecionamento",
  "mainPanelTabs.hostingTab.addRedirectTitle": "Adicionar redirecionamento",
  "mainPanelTabs.hostingTab.editRedirectTitle": "Editar redirecionamento",
  "mainPanelTabs.hostingTab.redirectFromPlaceholder": "/caminho-antigo",
  "mainPanelTabs.hostingTab.redirectToPlaceholder": "/caminho-novo",
  "mainPanelTabs.hostingTab.editRedirect": "Editar redirecionamento",
  "mainPanelTabs.hostingTab.deleteRedirect": "Excluir redirecionamento",
  "mainPanelTabs.hostingTab.confirmDeleteRedirectTitle":
    "Excluir redirecionamento?",
  "mainPanelTabs.hostingTab.confirmDeleteRedirectDescription":
    "Excluir o redirecionamento de {from}?",
  "mainPanelTabs.hostingTab.toastRedirectSaved": "Redirecionamento salvo",
  "mainPanelTabs.hostingTab.toastRedirectDeleted": "Redirecionamento excluído",
  "mainPanelTabs.hostingTab.errorRedirectFieldsRequired":
    "Origem e destino são obrigatórios",
  // Implantações — colunas, histórico + logs de build
  "mainPanelTabs.hostingTab.colFramework": "Framework",
  "mainPanelTabs.hostingTab.colDuration": "Duração",
  "mainPanelTabs.hostingTab.colActor": "Autor",
  "mainPanelTabs.hostingTab.colAction": "Ação",
  "mainPanelTabs.hostingTab.colDate": "Data",
  "mainPanelTabs.hostingTab.production": "Produção",
  "mainPanelTabs.hostingTab.showBuildMessage": "Mostrar mensagem do build",
  "mainPanelTabs.hostingTab.deployHistory": "Histórico de implantações",
  "mainPanelTabs.hostingTab.noDeployHistory":
    "Nenhum histórico de implantação ainda.",
  "mainPanelTabs.hostingTab.deployHistoryError":
    "Falha ao carregar o histórico de implantações",
  "mainPanelTabs.hostingTab.actionDeploy": "Implantar",
  "mainPanelTabs.hostingTab.actionRedeploy": "Reimplantar",
  "mainPanelTabs.hostingTab.actionRollback": "Reverter",
  "mainPanelTabs.hostingTab.typeBuild": "Build",
  "mainPanelTabs.hostingTab.typeFastDeploy": "Fast-deploy",
  "mainPanelTabs.hostingTab.typeDeploy": "Deploy",
  "mainPanelTabs.hostingTab.outcomePending": "em andamento",
  "mainPanelTabs.hostingTab.outcomeSuccess": "sucesso",
  "mainPanelTabs.hostingTab.outcomeFailure": "falha",
  "mainPanelTabs.hostingTab.buildLogs": "Logs de build",
  "mainPanelTabs.hostingTab.buildLogsTitle": "Logs de build",
  "mainPanelTabs.hostingTab.buildLogsCommit": "Commit {commit}",
  "mainPanelTabs.hostingTab.buildLogsNotWiredTitle":
    "Logs de build ainda não estão disponíveis para esta plataforma",
  "mainPanelTabs.hostingTab.buildLogsNotWiredDescription":
    "Esta plataforma ainda não expõe logs de build para o Studio.",
  "mainPanelTabs.hostingTab.buildLogsError":
    "Falha ao carregar os logs de build",
  "mainPanelTabs.hostingTab.buildLogsEmpty":
    "Nenhum log de build disponível para este commit.",
  "mainPanelTabs.hostingTab.buildLogsTruncated":
    "Saída truncada — abra o log completo para ver tudo.",
  "mainPanelTabs.hostingTab.buildLogsOpenFull": "Abrir log completo",
  "mainPanelTabs.hostingTab.domains": "Domínios",
  "mainPanelTabs.hostingTab.domainsError": "Falha ao carregar domínios",
  "mainPanelTabs.hostingTab.noDomains":
    "Nenhum domínio personalizado configurado.",
  "mainPanelTabs.hostingTab.addDomain": "Adicionar domínio",
  "mainPanelTabs.hostingTab.addDomainTitle":
    "Vincular um domínio personalizado",
  "mainPanelTabs.hostingTab.colHost": "Host",
  "mainPanelTabs.hostingTab.canonical": "principal",
  "mainPanelTabs.hostingTab.statusActive": "Ativo",
  "mainPanelTabs.hostingTab.statusPending": "Pendente",
  "mainPanelTabs.hostingTab.statusActionRequired": "Ação necessária",
  "mainPanelTabs.hostingTab.detailZoneNotOnboarded":
    "Este domínio ainda não está totalmente configurado — fale com a gente para concluir a conexão.",
  "mainPanelTabs.hostingTab.deleteDomain": "Remover domínio",
  "mainPanelTabs.hostingTab.confirmDeleteDomainTitle": "Remover este domínio?",
  "mainPanelTabs.hostingTab.confirmDeleteDomainDescription":
    "{host} deixará de servir este site. O roteamento e o TLS são removidos.",
  "mainPanelTabs.hostingTab.toastDomainSaved": "Domínio vinculado",
  "mainPanelTabs.hostingTab.toastDomainDeleted": "Domínio removido",
  "mainPanelTabs.hostingTab.domainHostPlaceholder": "www.suamarca.com",
  "mainPanelTabs.hostingTab.errorDomainHostRequired": "Informe um host",
  "mainPanelTabs.e2eTab.title": "E2E",
  "mainPanelTabs.e2eTab.subtitle": "Verificações ponta a ponta de {site}",
  "mainPanelTabs.e2eTab.helpTitle": "Como funcionam os testes E2E",
  "mainPanelTabs.e2eTab.helpIntro":
    "Os testes E2E rodam verificações ponta a ponta automatizadas na URL de produção do seu site, num navegador real.",
  "mainPanelTabs.e2eTab.helpTypes":
    "Escolha um tipo ao rodar: Journey percorre todo o funil de compra; PDP check valida os botões da página de produto em vários dispositivos.",
  "mainPanelTabs.e2eTab.helpRun":
    "Clique em Run test e escolha um tipo. A execução é enfileirada e aparece abaixo com o veredito de sucesso/falha quando termina.",
  "mainPanelTabs.e2eTab.helpResults":
    "Abra uma execução para ver os passos por viewport, web vitals, console e rede, um vídeo e um trace do Playwright.",
  "mainPanelTabs.e2eTab.runs": "Execuções",
  "mainPanelTabs.e2eTab.colRun": "Execução",
  "mainPanelTabs.e2eTab.colStatus": "Status",
  "mainPanelTabs.e2eTab.colStarted": "Iniciada",
  "mainPanelTabs.e2eTab.colSummary": "Resumo",
  "mainPanelTabs.e2eTab.statusPassed": "Aprovada",
  "mainPanelTabs.e2eTab.statusFailed": "Falhou",
  "mainPanelTabs.e2eTab.statusRunning": "Em execução",
  "mainPanelTabs.e2eTab.checks": "{passed}/{total} verificações",
  "mainPanelTabs.e2eTab.noRuns": "Nenhuma execução E2E ainda.",
  "mainPanelTabs.e2eTab.runsError": "Falha ao carregar as execuções E2E",
  "mainPanelTabs.e2eTab.noSiteTitle": "Nenhum site vinculado",
  "mainPanelTabs.e2eTab.noSiteDescription":
    "Este projeto ainda não está vinculado a um site hospedado.",
  "mainPanelTabs.e2eTab.notConnectedTitle": "E2E ainda não conectado",
  "mainPanelTabs.e2eTab.notConnectedDescription":
    "As execuções E2E deste site aparecerão aqui quando a conexão com o control-plane estiver configurada.",
  "mainPanelTabs.e2eTab.runE2e": "Executar E2E",
  "mainPanelTabs.e2eTab.running": "Enfileirando…",
  "mainPanelTabs.e2eTab.runConfirmTitle": "Executar verificações E2E?",
  "mainPanelTabs.e2eTab.runConfirmDescription":
    "Enfileirar uma nova execução ponta a ponta para este site?",
  "mainPanelTabs.e2eTab.runConfirm": "Executar",
  "mainPanelTabs.e2eTab.cancel": "Cancelar",
  "mainPanelTabs.e2eTab.toastE2eQueued": "Execução E2E enfileirada",
  "mainPanelTabs.e2eTab.runTest": "Executar teste",
  "mainPanelTabs.e2eTab.runTestTitle": "Executar um teste",
  "mainPanelTabs.e2eTab.runTestDescription":
    "Escolha uma verificação para enfileirar neste site.",
  "mainPanelTabs.e2eTab.selectType": "Tipo de teste",
  "mainPanelTabs.e2eTab.selectTypePlaceholder": "Selecione um tipo de teste",
  "mainPanelTabs.e2eTab.typesError": "Falha ao carregar os tipos de teste",
  "mainPanelTabs.e2eTab.noTypes": "Nenhum tipo de teste disponível.",
  "mainPanelTabs.e2eTab.toastRunQueued": "Execução E2E enfileirada",
  "mainPanelTabs.e2eTab.colCommand": "Comando",
  "mainPanelTabs.e2eTab.summaryExitCode": "saída {code}",
  "mainPanelTabs.e2eTab.summaryFiles": "{count} arquivos",
  "mainPanelTabs.e2eTab.delete": "Excluir",
  "mainPanelTabs.e2eTab.deleteRun": "Excluir execução",
  "mainPanelTabs.e2eTab.confirmDeleteRunTitle": "Excluir esta execução?",
  "mainPanelTabs.e2eTab.confirmDeleteRun":
    "A execução {runId} e seus artefatos serão removidos permanentemente.",
  "mainPanelTabs.e2eTab.toastRunDeleted": "Execução E2E excluída",
  "mainPanelTabs.e2eTab.runDetail": "Detalhe da execução",
  "mainPanelTabs.e2eTab.close": "Fechar",
  "mainPanelTabs.e2eTab.detailError": "Falha ao carregar o detalhe da execução",
  "mainPanelTabs.e2eTab.url": "URL",
  "mainPanelTabs.e2eTab.command": "Comando",
  "mainPanelTabs.e2eTab.duration": "Duração",
  "mainPanelTabs.e2eTab.totalDuration": "Duração total",
  "mainPanelTabs.e2eTab.exitCode": "Código de saída",
  "mainPanelTabs.e2eTab.viewport": "Viewport",
  "mainPanelTabs.e2eTab.funnel": "Funil",
  "mainPanelTabs.e2eTab.steps": "Passos",
  "mainPanelTabs.e2eTab.stepsCount": "{count} passos",
  "mainPanelTabs.e2eTab.failCount": "{count} com falha",
  "mainPanelTabs.e2eTab.vitals": "Web Vitals",
  "mainPanelTabs.e2eTab.console": "Console",
  "mainPanelTabs.e2eTab.network": "Rede",
  "mainPanelTabs.e2eTab.video": "Vídeo",
  "mainPanelTabs.e2eTab.trace": "Trace",
  "mainPanelTabs.e2eTab.openTrace": "Abrir no Playwright Trace Viewer",
  "mainPanelTabs.e2eTab.downloadTrace": "Baixar .zip",
  "mainPanelTabs.e2eTab.noReport":
    "Sem relatório detalhado para esta execução.",
  "mainPanelTabs.e2eTab.noConsole": "Nenhuma saída de console.",
  "mainPanelTabs.e2eTab.noNetwork": "Nenhuma atividade de rede capturada.",
  "mainPanelTabs.e2eTab.critical": "crítico",
  "mainPanelTabs.e2eTab.missingSelector": "Seletor ausente {slug}",
  "mainPanelTabs.e2eTab.expected": "Esperado: {value}",
  "mainPanelTabs.e2eTab.checksTitle": "Verificações",
  "mainPanelTabs.e2eTab.colCheck": "Verificação",
  "mainPanelTabs.e2eTab.colViewport": "Viewport",
  "mainPanelTabs.e2eTab.colDuration": "Duração",
  "mainPanelTabs.e2eTab.artifacts": "Artefatos",
  "mainPanelTabs.e2eTab.noArtifacts": "Nenhum artefato para esta execução.",
  "mainPanelTabs.e2eTab.openArtifact": "Abrir",
  "mainPanelTabs.e2eTab.viewScreenshot": "Ver captura de tela",
  "mainPanelTabs.analyticsTab.title": "Deco Analytics",
  "mainPanelTabs.analyticsTab.subtitle": "Tráfego e uso de {site}",
  "mainPanelTabs.analyticsTab.noSiteTitle": "Nenhum site vinculado",
  "mainPanelTabs.analyticsTab.noSiteDescription":
    "Este projeto ainda não está vinculado a um site hospedado.",
  "mainPanelTabs.analyticsTab.notConnectedTitle":
    "Análises ainda não conectadas",
  "mainPanelTabs.analyticsTab.notConnectedDescription":
    "As análises deste site aparecerão aqui quando a conexão com o control-plane estiver configurada.",
  "mainPanelTabs.analyticsTab.statusError":
    "Falha ao carregar o status das análises",
  "mainPanelTabs.analyticsTab.backendNotConfiguredTitle":
    "Backend de análises não configurado",
  "mainPanelTabs.analyticsTab.backendNotConfiguredDescription":
    "O coletor de análises ainda não está conectado a este ambiente.",
  // Registro
  "mainPanelTabs.analyticsTab.registerTitle": "Começar a coletar análises",
  "mainPanelTabs.analyticsTab.registerDescription":
    "Registra {host} no coletor do Deco Analytics para começar a registrar o tráfego.",
  "mainPanelTabs.analyticsTab.registerHostFallback": "o domínio deste site",
  "mainPanelTabs.analyticsTab.modules": "Módulos",
  "mainPanelTabs.analyticsTab.moduleCore": "Core",
  "mainPanelTabs.analyticsTab.moduleCoreHint":
    "Pageviews + eventos personalizados (sempre ativo)",
  "mainPanelTabs.analyticsTab.moduleCommerce": "Commerce",
  "mainPanelTabs.analyticsTab.moduleCommerceHint":
    "view_item, add_to_cart, purchase…",
  "mainPanelTabs.analyticsTab.moduleVitals": "Web vitals",
  "mainPanelTabs.analyticsTab.moduleVitalsHint": "LCP, INP, CLS, TTFB, FCP",
  "mainPanelTabs.analyticsTab.moduleErrors": "Erros",
  "mainPanelTabs.analyticsTab.moduleErrorsHint": "Erros de onerror / rejeições",
  "mainPanelTabs.analyticsTab.moduleEngagement": "Engajamento",
  "mainPanelTabs.analyticsTab.moduleEngagementHint":
    "Profundidade de rolagem, permanência",
  "mainPanelTabs.analyticsTab.hostLabel": "Nome do host",
  "mainPanelTabs.analyticsTab.hostPlaceholder": "loja.com.br",
  "mainPanelTabs.analyticsTab.hostHint":
    "Este site não tem domínio de produção registrado — informe o host para coletar.",
  "mainPanelTabs.analyticsTab.registerInstallHint":
    "Depois de habilitar, o tráfego é coletado automaticamente — nada de código pra adicionar.",
  "mainPanelTabs.analyticsTab.enableAnalytics": "Habilitar análises",
  "mainPanelTabs.analyticsTab.enabling": "Habilitando…",
  "mainPanelTabs.analyticsTab.toastRegistered": "Análises habilitadas",
  // Visão registrada
  "mainPanelTabs.analyticsTab.collection": "Coleta",
  "mainPanelTabs.analyticsTab.active": "Ativa",
  "mainPanelTabs.analyticsTab.paused": "Pausada",
  "mainPanelTabs.analyticsTab.collectingUnder": "Coletando em {host}",
  "mainPanelTabs.analyticsTab.idLabel": "id {id}",
  "mainPanelTabs.analyticsTab.pause": "Pausar",
  "mainPanelTabs.analyticsTab.resume": "Retomar",
  "mainPanelTabs.analyticsTab.edit": "Editar",
  "mainPanelTabs.analyticsTab.sampling": "amostragem {percent}%",
  "mainPanelTabs.analyticsTab.toastCollectionUpdated": "Coleta atualizada",
  "mainPanelTabs.analyticsTab.unregister": "Cancelar registro",
  "mainPanelTabs.analyticsTab.unregistering": "Removendo…",
  "mainPanelTabs.analyticsTab.unregisterTitle":
    "Cancelar registro das análises",
  "mainPanelTabs.analyticsTab.unregisterDescription":
    "Parar de coletar de {site} e remover sua configuração. Você pode registrá-lo novamente depois.",
  "mainPanelTabs.analyticsTab.toastUnregistered":
    "Registro das análises cancelado",
  // Diálogo de edição
  "mainPanelTabs.analyticsTab.editTitle": "Editar análises",
  "mainPanelTabs.analyticsTab.editModules": "Módulos",
  "mainPanelTabs.analyticsTab.editSampling": "Amostragem (%)",
  "mainPanelTabs.analyticsTab.editSamplingHint":
    "Percentual de eventos a manter, 1–100%.",
  "mainPanelTabs.analyticsTab.save": "Salvar",
  "mainPanelTabs.analyticsTab.saving": "Salvando…",
  "mainPanelTabs.analyticsTab.cancel": "Cancelar",
  // Uso
  "mainPanelTabs.analyticsTab.usageTitle": "Uso",
  "mainPanelTabs.analyticsTab.usageEmpty": "Nenhum evento coletado ainda.",
  // Rastreamento (só uso — sem internals de entrega/faturamento)
  "mainPanelTabs.analyticsTab.installTitle": "Rastreamento",
  "mainPanelTabs.analyticsTab.installAuto":
    "As análises estão ativas neste site — são adicionadas automaticamente, nada pra colar.",
  "mainPanelTabs.analyticsTab.installTrackPrefix":
    "Envie eventos personalizados do seu código via ",
  // Dashboard (views /data com escopo de tenant), em seções colapsáveis.
  "mainPanelTabs.analyticsTab.dashboardTitle": "Painel",
  "mainPanelTabs.analyticsTab.configSectionTitle": "Configuração",
  "mainPanelTabs.analyticsTab.rangeLabel": "Período",
  "mainPanelTabs.analyticsTab.range5m": "Últimos 5 minutos",
  "mainPanelTabs.analyticsTab.range15m": "Últimos 15 minutos",
  "mainPanelTabs.analyticsTab.range30m": "Últimos 30 minutos",
  "mainPanelTabs.analyticsTab.range1h": "Última hora",
  "mainPanelTabs.analyticsTab.range24h": "Últimas 24 horas",
  "mainPanelTabs.analyticsTab.range7d": "Últimos 7 dias",
  "mainPanelTabs.analyticsTab.range30d": "Últimos 30 dias",
  "mainPanelTabs.analyticsTab.viewOverview": "Visão geral",
  "mainPanelTabs.analyticsTab.viewLive": "Ao vivo",
  "mainPanelTabs.analyticsTab.viewBehaviour": "Comportamento",
  "mainPanelTabs.analyticsTab.viewEvents": "Eventos",
  "mainPanelTabs.analyticsTab.viewErrors": "Erros",
  "mainPanelTabs.analyticsTab.viewExperiments": "Experimentos",
  "mainPanelTabs.analyticsTab.viewVitals": "Web Vitals",
  "mainPanelTabs.analyticsTab.viewQuality": "Qualidade",
  "mainPanelTabs.analyticsTab.viewUsage": "Uso",
  "mainPanelTabs.analyticsTab.viewInstall": "Instalação",
  "mainPanelTabs.analyticsTab.dataLoadError":
    "Não foi possível carregar esta visão.",
  "mainPanelTabs.analyticsTab.dataEmpty": "Sem dados para este período ainda.",
  "mainPanelTabs.analyticsTab.panelEmpty": "Sem linhas.",
  "mainPanelTabs.analyticsTab.dataNotConfiguredTitle": "Painel indisponível",
  "mainPanelTabs.analyticsTab.dataNotConfiguredDescription":
    "A superfície de dados de analytics ainda não está ligada a este ambiente — a configuração abaixo continua funcionando.",
  // Registro por token (chave)
  "mainPanelTabs.analyticsTab.registerByKey":
    "Registrar por token (site fora do nosso CDN)",
  "mainPanelTabs.analyticsTab.registerByKeyHint":
    "Para dev, staging ou site fora do CDN. A tag carrega um token público e os eventos não são faturáveis.",
  "mainPanelTabs.analyticsTab.domainsLabel": "Domínios",
  "mainPanelTabs.analyticsTab.domainsPlaceholder":
    "loja.com.br, staging.loja.com.br",
  "mainPanelTabs.analyticsTab.domainsHint":
    "Domínios que o collector aceita (checagem de Origin); o primeiro é o principal. Obrigatório para um token.",
  "mainPanelTabs.analyticsTab.tokenTitle": "Token criado — copie agora",
  "mainPanelTabs.analyticsTab.tokenOnce":
    "Mostrado uma vez. É público (vai no script), então identifica mas nunca autentica — os eventos não são faturáveis.",
  "mainPanelTabs.analyticsTab.registeredOk": "Registrado",
  "mainPanelTabs.analyticsTab.copy": "Copiar",
  "mainPanelTabs.analyticsTab.copied": "Copiado",
  "mainPanelTabs.analyticsTab.dismiss": "Dispensar",
  "mainPanelTabs.analyticsTab.liveHint": "Ao vivo · atualiza a cada 5s",
  "mainPanelTabs.analyticsTab.installHow":
    "O collector carrega async e nunca bloqueia a página. Um site é identificado pelo host (faturável) ou por um token público (para sites fora do nosso CDN).",
  "mainPanelTabs.analyticsTab.installHostTitle": "No nosso CDN (host)",
  "mainPanelTabs.analyticsTab.installKeyTitle": "Fora do CDN (token)",
  "mainPanelTabs.analyticsTab.installTokenNote":
    "O token é mostrado uma vez, no registro. Re-registre (desregistrar e habilitar por token) para gerar um novo.",
  "mainPanelTabs.analyticsTab.installSiteId": "Site ID (onde os eventos caem)",
  "mainPanelTabs.analyticsTab.rotateToken": "Rotacionar token",
  "mainPanelTabs.analyticsTab.rotating": "Rotacionando…",
  "mainPanelTabs.analyticsTab.emptyLive":
    "Nenhum visitante nos últimos minutos.",
  "mainPanelTabs.analyticsTab.emptyView":
    "Nada coletado para este período ainda.",
  "mainPanelTabs.cdnTab.title": "Monitor",
  "mainPanelTabs.cdnTab.noSiteTitle": "Nenhum site vinculado",
  "mainPanelTabs.cdnTab.noSiteBody":
    "Este projeto não está vinculado a um site, então não há tráfego de CDN para mostrar.",
  "mainPanelTabs.cdnTab.unconfiguredTitle": "Analytics de CDN indisponível",
  "mainPanelTabs.cdnTab.unconfiguredBody":
    "O warehouse de analytics não está configurado neste deployment.",
  "mainPanelTabs.cdnTab.errorTitle":
    "Não foi possível carregar o analytics de CDN",
  "mainPanelTabs.cdnTab.requests": "Requisições",
  "mainPanelTabs.cdnTab.bandwidth": "Banda",
  "mainPanelTabs.cdnTab.cacheHit": "Taxa de cache hit",
  "mainPanelTabs.cdnTab.avgLatency": "Latência média",
  "mainPanelTabs.cdnTab.errors5xx": "Erros 5xx",
  "mainPanelTabs.cdnTab.errors4xx": "Erros 4xx",
  "mainPanelTabs.cdnTab.success2xx": "Respostas 2xx",
  "mainPanelTabs.cdnTab.countries": "Países",
  "mainPanelTabs.cdnTab.usageOverTime": "Uso ao longo do tempo",
  "mainPanelTabs.cdnTab.emptyRange": "Nada coletado para este período ainda.",
  "mainPanelTabs.cdnTab.cacheStatus": "Status de cache",
  "mainPanelTabs.cdnTab.statusCodes": "Códigos de status",
  "mainPanelTabs.cdnTab.topPaths": "Principais caminhos",
  "mainPanelTabs.cdnTab.topCountries": "Principais países",
  "mainPanelTabs.cdnTab.status": "Status",
  "mainPanelTabs.cdnTab.code": "Código",
  "mainPanelTabs.cdnTab.path": "Caminho",
  "mainPanelTabs.cdnTab.country": "País",
  "mainPanelTabs.cdnTab.performance": "Performance",
  "mainPanelTabs.cdnTab.audience": "Audiência",
  "mainPanelTabs.cdnTab.pageviews": "Pageviews",
  "mainPanelTabs.cdnTab.visitors": "Visitantes",
  "mainPanelTabs.cdnTab.sessions": "Sessões",
  "mainPanelTabs.cdnTab.pageviewsOverTime": "Pageviews ao longo do tempo",
  "mainPanelTabs.cdnTab.topSources": "Principais origens",
  "mainPanelTabs.cdnTab.source": "Origem",
  "mainPanelTabs.cdnTab.devices": "Dispositivos",
  "mainPanelTabs.cdnTab.device": "Dispositivo",
  "mainPanelTabs.cdnTab.requestsPerPageview": "Requisições / Pageview",
  "mainPanelTabs.cdnTab.bandwidthPer10k": "Banda / 10k Pageviews",
  "mainPanelTabs.cdnTab.usageSubtitle":
    "Requisições e Pageviews (eixo esq.), Banda (eixo dir.)",
  "mainPanelTabs.cdnTab.measureBy": "Medir por",
  "mainPanelTabs.cdnTab.showAll": "Ver todos ({count})",
  "mainPanelTabs.cdnTab.showLess": "Ver menos",
  "mainPanelTabs.cdnTab.cacheStatusSubtitle": "Distribuição das respostas de cache",
  "mainPanelTabs.cdnTab.statusCodesSubtitle":
    "Distribuição dos status HTTP",
  "mainPanelTabs.mobileMainPanelTabSelect.chat": "Chat",
  "mainPanelTabs.mobileMainPanelTabSelect.library": "Biblioteca",
  "mainPanelTabs.mobileMainPanelTabSelect.mainView": "Visualização principal",
  "mainPanelTabs.mobileMainPanelTabSelect.tasks": "Tarefas",
  "mainPanelTabs.mobileMainPanelTabSelect.view": "Visualizar",
  "mainPanelTabs.previewTab.connectGithub": "Conectar GitHub",
  "mainPanelTabs.previewTab.connectGithubDescription":
    "Conecte um repositório do GitHub para construir e visualizar seu site aqui.",
  "mainPanelTabs.previewTab.noSourceToPreview": "Nenhuma fonte para visualizar",
  "mainPanelTabs.tabOverflowMenu.moreTabs": "Mais abas",
} satisfies Record<keyof typeof mainPanelTabsEn, string>;
