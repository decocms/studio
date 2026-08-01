import type { common as commonEn } from "../en/common.ts";

export const common = {
  "common.copy": "Copiar",
  "common.seeAll": "Ver todos os {count} {noun}",
  "common.accountPopover.account": "Conta",
  "common.accountPopover.adminDashboard": "Painel de administração",
  "common.accountPopover.community": "Comunidade",
  "common.accountPopover.copyUserId": "Copiar ID do usuário",
  "common.accountPopover.darkTheme": "Tema escuro",
  "common.accountPopover.defaultAccountLabel": "Conta",
  "common.accountPopover.defaultUserName": "Usuário",
  "common.accountPopover.disableSounds": "Desativar sons",
  "common.accountPopover.enableSounds": "Ativar sons",
  "common.accountPopover.failedToStopImpersonation":
    "Falha ao parar de representar",
  "common.accountPopover.githubRepo": "decocms/studio",
  "common.accountPopover.homepage": "Página inicial",
  "common.accountPopover.impersonating": "Representando",
  "common.accountPopover.lightTheme": "Tema claro",
  "common.accountPopover.preferences": "Preferências",
  "common.accountPopover.privacyPolicy": "Política de privacidade",
  "common.accountPopover.signOut": "Sair",
  "common.accountPopover.stopImpersonation": "Parar de representar",
  "common.accountPopover.systemTheme": "Tema do sistema",
  "common.accountPopover.termsOfUse": "Termos de uso",
  "common.accountPopover.userIdCopied": "ID do usuário copiado",
  "common.archivedOrgScreen.deletedGeneric":
    "Esta organização foi deletada ou não está mais disponível.",
  "common.archivedOrgScreen.deletedWithName":
    "{orgName} foi deletada ou não está mais disponível.",
  "common.archivedOrgScreen.goHome": "Ir para home",
  "common.archivedOrgScreen.orgUnavailable": "Organização indisponível",
  "common.authEntry.autoLoginFailed": "Falha no auto-login",
  "common.authEntry.autoLoginFailedWithError": "Falha no auto-login: {error}",
  "common.authEntry.browserOnlyCta": "Continuar no seu navegador",
  "common.authEntry.browserOnlyDescription":
    "Esta organização faz login com um link enviado por e-mail, que não pode ser aberto dentro do app. Continue no seu navegador para concluir o login.",
  "common.authEntry.browserOnlyTitle": "Bem-vindo ao deco",
  "common.authEntry.finishSignInInBrowser": "Conclua o login no seu navegador…",
  "common.authEntry.finishingSignIn": "Concluindo login…",
  "common.authEntry.noLoginOptions": "Nenhuma opção de login disponível",
  "common.authEntry.tryRestartingServer": "Tente reiniciar o servidor.",
  "common.desktopKeychainUnavailable.description":
    "O deco studio não conseguiu acessar as Chaves do macOS. Feche qualquer diálogo pendente das Chaves e tente novamente.",
  "common.desktopKeychainUnavailable.descriptionLinux":
    "O deco studio não conseguiu acessar o chaveiro do sistema. Verifique se um serviço de segredos como o GNOME Keyring ou o KWallet está em execução e desbloqueado e tente novamente.",
  "common.desktopKeychainUnavailable.retry": "Tentar novamente",
  "common.desktopKeychainUnavailable.retrying": "Tentando novamente…",
  "common.desktopKeychainUnavailable.title":
    "Não foi possível acessar sua sessão salva",
  "common.autoDomainJoinScreen.enterOrg": "Entrar em {orgName}",
  "common.autoDomainJoinScreen.goHome": "Ir para home",
  "common.autoDomainJoinScreen.joinDescription":
    "Qualquer pessoa com um e-mail @{domain} pode entrar nesta organização.",
  "common.autoDomainJoinScreen.joinError": "Falha ao entrar na organização",
  "common.autoDomainJoinScreen.joinPrompt": "Entrar em {orgName}?",
  "common.autoDomainJoinScreen.joining": "Entrando…",
  "common.capabilityLoadError.description":
    "Algo deu errado ao verificar seu acesso. Isso geralmente é temporário.",
  "common.capabilityLoadError.title":
    "Não foi possível carregar suas permissões",
  "common.capabilityLoadError.tryAgain": "Tentar novamente",
  "common.createOrganizationDialog.cancel": "Cancelar",
  "common.createOrganizationDialog.createButton": "Criar Organização",
  "common.createOrganizationDialog.creating": "Criando...",
  "common.createOrganizationDialog.description":
    "Configure uma nova organização para colaborar com outras pessoas.",
  "common.createOrganizationDialog.failedToCreate":
    "Falha ao criar organização",
  "common.createOrganizationDialog.failedToCreateGeneric":
    "Falha ao criar organização.",
  "common.createOrganizationDialog.invalidSlug":
    "O slug da organização é inválido",
  "common.createOrganizationDialog.nameDescription":
    "O nome da sua empresa ou organização",
  "common.createOrganizationDialog.nameLabel": "Nome da Organização",
  "common.createOrganizationDialog.namePlaceholder": "Acme Inc.",
  "common.createOrganizationDialog.title": "Criar uma nova organização",
  "common.createOrganizationDialog.urlLabel": "URL da Organização:",
  "common.deleteConnectionDialogs.cancel": "Cancelar",
  "common.deleteConnectionDialogs.delete": "Excluir",
  "common.deleteConnectionDialogs.deleteAnyway": "Excluir Mesmo Assim",
  "common.deleteConnectionDialogs.description":
    "Esta ação não pode ser desfeita. Isso excluirá permanentemente",
  "common.deleteConnectionDialogs.forceDeleteDescription": "A conexão",
  "common.deleteConnectionDialogs.forceDeleteTitle":
    "Conexão Usada por Agentes",
  "common.deleteConnectionDialogs.forceDeleteWarning":
    "Excluir esta conexão a removerá desses agentes, o que pode impactar fluxos de trabalho existentes que dependem deles.",
  "common.deleteConnectionDialogs.isUsedByAgents":
    "está sendo usada pelos seguintes agente(s):",
  "common.deleteConnectionDialogs.title": "Excluir Conexão?",
  "common.errorBoundary.newVersionAvailable": "Nova versão disponível",
  "common.errorBoundary.newVersionDeployed":
    "Uma nova versão foi implantada. Atualize para continuar.",
  "common.errorBoundary.refresh": "Atualizar",
  "common.errorBoundary.somethingWentWrong": "Algo deu errado",
  "common.errorBoundary.tryAgain": "Tentar novamente",
  "common.errorBoundary.unexpectedError": "Um erro inesperado ocorreu",
  "common.githubRepoPicker.accountNotListed": "Conta não listada?",
  "common.githubRepoPicker.addRepo": "Adicionar repositório",
  "common.githubRepoPicker.addedRepo": "Adicionado {name}",
  "common.githubRepoPicker.authenticatingGitHub": "Autenticando com GitHub",
  "common.githubRepoPicker.backToAccounts": "Voltar às contas",
  "common.githubRepoPicker.changeConnection": "Alterar conexão",
  "common.githubRepoPicker.checkAgain": "Verificar novamente",
  "common.githubRepoPicker.chooseRepositories": "Escolher repositórios",
  "common.githubRepoPicker.completeOAuthFlow":
    "Complete o fluxo OAuth no seu navegador",
  "common.githubRepoPicker.connectionExpiredMessage":
    "Sua conexão com o GitHub pode ter expirado. Reconecte para restaurar o acesso.",
  "common.githubRepoPicker.connectionFailed": "Conexão falhou",
  "common.githubRepoPicker.failedImport":
    "Falha ao importar repositório: {error}",
  "common.githubRepoPicker.failedImportFork":
    "Não foi possível importar o fork {name}. Se ele não estiver compartilhado com o aplicativo GitHub, adicione-o em GitHub → Settings → Installations e tente novamente.",
  "common.githubRepoPicker.failedLoadAccounts":
    "Falha ao carregar contas do GitHub",
  "common.githubRepoPicker.failedReconnect":
    "Falha ao reconectar GitHub: {error}",
  "common.githubRepoPicker.forkBadge": "Fork",
  "common.githubRepoPicker.githubConnected": "GitHub conectado",
  "common.githubRepoPicker.importFromGitHub": "Importar do GitHub",
  "common.githubRepoPicker.importedRepo": "Importado {name} do GitHub",
  "common.githubRepoPicker.installGitHubApp": "Instalar o aplicativo GitHub",
  "common.githubRepoPicker.installingGitHubConnection":
    "Instalando a conexão com GitHub...",
  "common.githubRepoPicker.noRepositoriesFound":
    "Nenhum repositório encontrado",
  "common.githubRepoPicker.noRepositoriesShared":
    "Ainda não há repositórios compartilhados com a Deco. Escolha no GitHub o que deseja compartilhar e volte aqui para continuar.",
  "common.githubRepoPicker.personalAccount": "Conta pessoal",
  "common.githubRepoPicker.private": "Privado",
  "common.githubRepoPicker.public": "Público",
  "common.githubRepoPicker.reconnectGitHub": "Reconectar GitHub",
  "common.githubRepoPicker.repositoryAccessNote":
    "Você decide exatamente o que a Deco pode acessar. Escolher “todos os repositórios” é opcional.",
  "common.githubRepoPicker.searchRepositories": "Pesquisar repositórios...",
  "common.githubRepoPicker.select": "Selecionar",
  "common.githubRepoPicker.selectConnection": "Selecione uma conexão",
  "common.githubRepoPicker.settingUpGitHub": "Configurando GitHub",
  "common.githubRepoPicker.setupRepositoriesTitle":
    "Permita que a Deco veja seus repositórios",
  "common.githubRepoPicker.somethingWentWrong":
    "Algo deu errado ao conectar ao GitHub.",
  "common.githubRepoPicker.tryAgain": "Tentar novamente",
  "common.githubRepoPicker.tryDifferentSearchTerm":
    "Tente um termo de pesquisa diferente",
  "common.githubRepoPicker.unknownError": "Erro desconhecido",
  "common.iconPicker.apply": "Aplicar",
  "common.iconPicker.changeColor": "Alterar cor",
  "common.iconPicker.failedToReadImage": "Falha ao ler arquivo de imagem",
  "common.iconPicker.filterPlaceholder": "Filtrar...",
  "common.iconPicker.iconsTab": "Ícones",
  "common.iconPicker.imageTooLarge": "A imagem deve ser menor que 2MB",
  "common.iconPicker.noIconsFound": "Nenhum ícone encontrado",
  "common.iconPicker.or": "ou",
  "common.iconPicker.pasteUrlPlaceholder": "Cole a URL da imagem...",
  "common.iconPicker.randomIcon": "Ícone aleatório",
  "common.iconPicker.uploadHint": "Clique para enviar uma imagem (máx 2MB)",
  "common.iconPicker.uploadTab": "Upload",
  "common.importFromDecoDialog.cancel": "Cancelar",
  "common.importFromDecoDialog.failedToConnectGithub":
    "Falha ao conectar GitHub",
  "common.importFromDecoDialog.failedToCreateAgent":
    "Falha ao criar o agente importado",
  "common.importFromDecoDialog.failedToCreateConnection":
    "Falha ao criar conexão",
  "common.importFromDecoDialog.githubNotConnected":
    "GitHub não está conectado. Conclua a configuração do GitHub e tente novamente.",
  "common.importFromDecoDialog.goBack": "Voltar",
  "common.importFromDecoDialog.import": "Importar",
  "common.importFromDecoDialog.importFailed": "Falha na importação: {error}",
  "common.importFromDecoDialog.importSuccess": "Importado {slug} de deco.cx",
  "common.importFromDecoDialog.importing": "Importando...",
  "common.importFromDecoDialog.installGithubApp":
    'Instale o aplicativo GitHub na organização "{owner}" para importar este site. {installUrl}',
  "common.importFromDecoDialog.loadingSites": "Carregando sites...",
  "common.importFromDecoDialog.noConnectionId":
    "O servidor não retornou um ID de conexão",
  "common.importFromDecoDialog.noSitesFound":
    "Nenhum site encontrado para esta conta.",
  "common.importFromDecoDialog.noSitesMatch":
    'Nenhum site corresponde a "{search}"',
  "common.importFromDecoDialog.retryGithubSetup":
    "Tentar configurar GitHub novamente",
  "common.importFromDecoDialog.searchPlaceholder": "Procurar sites...",
  "common.importFromDecoDialog.selectGithubConnection":
    "Selecione uma conexão GitHub",
  "common.importFromDecoDialog.settingUpGithub":
    "Configurando conexão com GitHub...",
  "common.importFromDecoDialog.siteNoLongerAvailable":
    "O site selecionado não está mais disponível",
  "common.importFromDecoDialog.title": "Importar de deco.cx",
  "common.importFromDecoDialog.unknownError": "Erro desconhecido",
  "common.index.goBack": "Voltar",
  "common.index.pageNotFound": "Página não encontrada",
  "common.index.pageNotFoundDescription":
    "A página que você está procurando não existe ou foi movida.",
  "common.inviteMemberDialog.cancelButton": "Cancelar",
  "common.inviteMemberDialog.emailLabel": "Endereços de e-mail",
  "common.inviteMemberDialog.emailPlaceholder":
    "Digite os endereços de e-mail separados por vírgulas ou quebras de linha\ne.g. usuario1@example.com, usuario2@example.com\nou um por linha",
  "common.inviteMemberDialog.errorFailedInvite":
    "Falha ao convidar {count} membro(s)",
  "common.inviteMemberDialog.errorGeneric": "Falha ao convidar membros",
  "common.inviteMemberDialog.errorNoValidEmail":
    "Digite pelo menos um endereço de e-mail válido",
  "common.inviteMemberDialog.errorSelectRole": "Selecione uma função",
  "common.inviteMemberDialog.inviteButton": "Convidar {count} membro(s)",
  "common.inviteMemberDialog.invitingButton": "Convidando...",
  "common.inviteMemberDialog.permAllConnections": "Todas as conexões",
  "common.inviteMemberDialog.permAllTools": "todas as ferramentas",
  "common.inviteMemberDialog.permConnections": "{count} conexão(ões)",
  "common.inviteMemberDialog.permFullOrgAccess": "Acesso total à organização",
  "common.inviteMemberDialog.permOrgPerms": "{count} permissão(ns) de org",
  "common.inviteMemberDialog.permTools": "{count} ferramenta(s)",
  "common.inviteMemberDialog.roleSelectPlaceholder": "Selecione uma função",
  "common.inviteMemberDialog.successMultiple":
    "{count} membros convidados com sucesso!",
  "common.inviteMemberDialog.successSingle": "Membro convidado com sucesso!",
  "common.inviteMemberDialog.title": "Convidar membros",
  "common.keyboardShortcutsDialog.title": "Atalhos de teclado",
  "common.noAccessScreen.askAdminToInvite":
    "Peça a um administrador que o convide.",
  "common.noAccessScreen.couldNotFind":
    "Não conseguimos encontrar uma organização chamada",
  "common.noAccessScreen.goToHome": "Ir para home",
  "common.noAccessScreen.noAccess": "Sem acesso",
  "common.noAccessScreen.noAccessTo": "Você não tem acesso a",
  "common.noAccessScreen.organizationNotFound": "Organização não encontrada",
  "common.pendingInviteScreen.acceptButton": "Aceitar convite",
  "common.pendingInviteScreen.acceptDescription":
    "Aceite o convite para se juntar a esta organização.",
  "common.pendingInviteScreen.acceptingButton": "Aceitando…",
  "common.pendingInviteScreen.declineButton": "Recusar",
  "common.pendingInviteScreen.decliningButton": "Recusando…",
  "common.pendingInviteScreen.failedToAccept": "Falha ao aceitar o convite",
  "common.pendingInviteScreen.failedToDecline": "Falha ao recusar o convite",
  "common.pendingInviteScreen.invitationDeclined": "Convite recusado",
  "common.pendingInviteScreen.invitedTo": "Você foi convidado para {orgName}",
  "common.requestPendingScreen.description":
    "Sua solicitação para ingressar em {orgName} está aguardando aprovação de um administrador. Você terá acesso após a aprovação.",
  "common.requestPendingScreen.goHome": "Ir para início",
  "common.requestPendingScreen.title": "Solicitação pendente",
  "common.requestToJoinScreen.description":
    "Um administrador deve aprovar solicitações de e-mails @{domain} antes que você possa entrar.",
  "common.requestToJoinScreen.failedToRequest": "Falha ao solicitar acesso",
  "common.requestToJoinScreen.goToHome": "Ir para início",
  "common.requestToJoinScreen.requestButton": "Solicitar acesso",
  "common.requestToJoinScreen.requesting": "Solicitando…",
  "common.requestToJoinScreen.title": "Solicitar acesso a {orgName}?",
  "common.signInScreen.configLoadFailed":
    "Não foi possível carregar as opções de login.",
  "common.signInScreen.tryAgain": "Tentar novamente",
  "common.simpleIconPicker.changeIcon": "Alterar ícone",
  "common.simpleIconPicker.filterPlaceholder": "Filtrar…",
  "common.simpleIconPicker.noIconsFound": "Nenhum ícone encontrado",
  "common.ssoRequiredScreen.goBack": "Voltar",
  "common.ssoRequiredScreen.orgRequiresSsoAuth":
    "Esta organização requer autenticação SSO para acessar.",
  "common.ssoRequiredScreen.requiresSsoAuth": "requer autenticação SSO",
  "common.ssoRequiredScreen.signInWithSso": "Entrar com SSO",
  "common.ssoRequiredScreen.title": "Autenticação SSO Necessária",
  "common.ssoRequiredScreen.via": "via {domain}",
  "common.tagMultiSelect.addTags": "Adicionar tags...",
  "common.tagMultiSelect.available": "Disponível",
  "common.tagMultiSelect.createTag": 'Criar "{tagName}"',
  "common.tagMultiSelect.noTagsFound": "Nenhuma tag encontrada.",
  "common.tagMultiSelect.searchOrCreate": "Pesquisar ou criar...",
  "common.tagMultiSelect.selected": "Selecionado",
  "common.toolInputForm.enterPlaceholder": "Digite {fieldKey}…",
  "common.toolInputForm.false": "falso",
  "common.toolInputForm.jsonPlaceholder": "Digite {fieldKey} como JSON…",
  "common.toolInputForm.selectPlaceholder": "Selecione…",
  "common.toolInputForm.true": "verdadeiro",
  "common.toolSetSelector.filterAll": "Todos",
  "common.toolSetSelector.filterSelected": "Selecionados",
  "common.toolSetSelector.filterUnselected": "Não selecionados",
  "common.toolSetSelector.noConnectionsAvailable": "Nenhuma conexão disponível",
  "common.toolSetSelector.noConnectionsFound": "Nenhuma conexão encontrada",
  "common.toolSetSelector.noServersSelected": "Nenhum servidor selecionado",
  "common.toolSetSelector.noToolsAvailable":
    "Esta conexão não tem ferramentas disponíveis",
  "common.toolSetSelector.noUnselectedServers":
    "Nenhum servidor não selecionado",
  "common.toolSetSelector.searchPlaceholder": "Pesquisar servidores MCP...",
  "common.toolSetSelector.selectConnection":
    "Selecione uma conexão para visualizar suas ferramentas",
  "common.useStartThreadFromPrompt.failedToStartChat":
    "Falha ao iniciar o chat. Tente novamente.",
  "common.useStartThreadFromPrompt.mcpClientNotAvailable":
    "Cliente MCP não disponível",
  "common.createAgentDropdown.createFromScratch": "Criar do zero",
  "common.createAgentDropdown.importFromGitHub": "Importar do GitHub",
  "common.createAgentDropdown.importFromDeco": "Importar do deco.cx",
  "common.mainPanelTabs.overview": "Visão Geral",
  "common.mainPanelTabs.preview": "Visualização",
  "common.mainPanelTabs.code": "Código",
  "common.mainPanelTabs.content": "Conteúdo",
  "common.mainPanelTabs.assets": "Assets",
  "common.mainPanelTabs.reviewChanges": "Revisar alterações",
  "common.mainPanelTabs.automations": "Automações",
  "common.mainPanelTabs.settings": "Configurações",
  "common.mainPanelTabs.report": "Relatório",
  "common.taskBoard.listView": "Lista",
  "common.taskBoard.boardView": "Quadro",
  "common.openExternalFailed": "Não foi possível abrir este link no navegador.",
} satisfies Record<keyof typeof commonEn, string>;
