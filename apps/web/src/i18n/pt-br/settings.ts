import type { settings as settingsEn } from "../en/settings.ts";

export const settings = {
  "settings.title": "Perfil e preferências",
  "settings.nav.organization": "Organização",
  "settings.nav.general": "Geral",
  "settings.nav.brandContext": "Contexto da marca",
  "settings.nav.aiProviders": "Provedores de IA",
  "settings.nav.secrets": "Segredos",
  "settings.nav.billing": "Cobrança",
  "settings.nav.buckets": "Buckets",
  "settings.nav.syncedRepos": "Repos sincronizados",
  "settings.syncedRepos.pageDescription":
    "Repositórios do GitHub espelhados em pastas somente leitura da biblioteca, sincronizados a cada poucos minutos. Ótimo para um repo de skills compartilhado.",
  "settings.syncedRepos.addRepo": "Adicionar repo",
  "settings.syncedRepos.cancel": "Cancelar",
  "settings.syncedRepos.create": "Criar",
  "settings.syncedRepos.creating": "Criando…",
  "settings.syncedRepos.created":
    'Sincronização criada — sincronizando em "{volume}" em segundo plano',
  "settings.syncedRepos.emptyTitle": "Nenhum repo sincronizado ainda",
  "settings.syncedRepos.emptyDescription":
    "Escolha um repositório do GitHub e ele aparecerá na biblioteca como uma pasta somente leitura, sincronizada automaticamente.",
  "settings.syncedRepos.failed": "Algo deu errado",
  "settings.syncedRepos.nameDialogDescription":
    "{repo} será mantido em sincronia nesta pasta somente leitura da biblioteca.",
  "settings.syncedRepos.nameDialogTitle": "Nomeie a pasta sincronizada",
  "settings.syncedRepos.namePlaceholder": "nome-da-pasta",
  "settings.syncedRepos.pickerTitle": "Sincronizar um repo na biblioteca",
  "settings.syncedRepos.remove": "Parar de sincronizar",
  "settings.syncedRepos.removeDescription":
    "Os arquivos já sincronizados continuam na biblioteca; só a sincronização para. Você pode apagar a pasta depois, se não precisar dela.",
  "settings.syncedRepos.removeTitle": 'Parar de sincronizar "{volume}"?',
  "settings.syncedRepos.removed": "Sincronização removida",
  "settings.syncedRepos.rowSubtitle": "Pasta da biblioteca: {volume}",
  "settings.nav.build": "Criação",
  "settings.nav.connections": "Conexões",
  "settings.nav.agents": "Agentes",
  "settings.nav.automations": "Automações",
  "settings.nav.store": "Loja",
  "settings.nav.manage": "Gerenciar",
  "settings.nav.monitor": "Monitoramento",
  "settings.nav.members": "Membros",
  "settings.nav.roles": "Cargos",
  "settings.nav.security": "Segurança",
  "settings.nav.account": "Conta",
  "settings.nav.profile": "Perfil e preferências",
  "settings.nav.signOut": "Sair",
  "settings.profile.avatar": "Avatar",
  "settings.profile.displayName": "Nome de exibição",
  "settings.profile.displayNamePlaceholder": "Seu nome",
  "settings.profile.email": "E-mail",
  "settings.profile.updateSuccess": "Perfil atualizado com sucesso",
  "settings.profile.updateError": "Falha ao atualizar o perfil",
  "settings.preferences.title": "Preferências",
  "settings.preferences.theme": "Tema",
  "settings.preferences.themeDescription": "Seu esquema de cores preferido.",
  "settings.preferences.themeLight": "Tema claro",
  "settings.preferences.themeDark": "Tema escuro",
  "settings.preferences.themeSystem": "Tema do sistema",
  "settings.preferences.language": "Idioma",
  "settings.preferences.languageDescription": "O idioma da interface.",
  "settings.preferences.notifications": "Notificações",
  "settings.preferences.notificationsDescription":
    "Receba notificações do navegador para eventos importantes.",
  "settings.preferences.notificationsDenied":
    "Notificações negadas. Habilite-as nas configurações do seu navegador.",
  "settings.preferences.sounds": "Sons",
  "settings.preferences.soundsDescription":
    "Reproduza sons para ações de agentes e notificações.",
  "settings.preferences.soundsPreview": "Ouvir som de notificação",
  "settings.preferences.terminalVisible":
    "Mostrar terminal do preview por padrão",
  "settings.preferences.terminalVisibleDescription":
    "Abrir o terminal do preview automaticamente em vez de mantê-lo oculto até você exibi-lo.",
  "settings.preferences.toolApproval": "Aprovação de ferramentas",
  "settings.preferences.toolApprovalDescription":
    "Controle como as ferramentas são aprovadas antes da execução.",
  "settings.preferences.toolApprovalAsk": "Perguntar antes de editar",
  "settings.preferences.toolApprovalAskShort": "Perguntar",
  "settings.preferences.toolApprovalAskDescription":
    "Aprova automaticamente ferramentas somente leitura",
  "settings.preferences.toolApprovalAuto": "Aprovar automaticamente",
  "settings.preferences.toolApprovalAutoShort": "Auto",
  "settings.preferences.toolApprovalAutoDescription":
    "Executa tudo sem aprovação",
  "settings.automations.browseAgentsButton": "Procurar agentes",
  "settings.automations.emptyDescription":
    "As automa\u00e7\u00f5es s\u00e3o criadas por agente. Abra um agente e adicione uma na aba de Automa\u00e7\u00f5es.",
  "settings.automations.emptyTitle": "Nenhuma automa\u00e7\u00e3o ainda",
  "settings.automations.noResultsDescription":
    'Nenhuma automa\u00e7\u00e3o corresponde a "{search}"',
  "settings.automations.noResultsTitle":
    "Nenhuma automa\u00e7\u00e3o encontrada",
  "settings.automations.pageTitle": "Automa\u00e7\u00f5es",
  "settings.automations.searchPlaceholder": "Pesquisar automa\u00e7\u00f5es...",
  "settings.brandFormSections.autoExtractDescription":
    "Digite o URL do seu site e extrairemos automaticamente as cores, fontes, logos e vis\u00e3o geral da sua marca.",
  "settings.brandFormSections.autoExtractTitle":
    "Auto-extrair contexto da marca",
  "settings.brandFormSections.colorPlaceholder": "#000000",
  "settings.brandFormSections.colorRoleAccent": "Destaque",
  "settings.brandFormSections.colorRoleBackground": "Fundo",
  "settings.brandFormSections.colorRoleForeground": "Primeiro Plano",
  "settings.brandFormSections.colorRolePrimary": "Prim\u00e1ria",
  "settings.brandFormSections.colorRoleSecondary": "Secund\u00e1ria",
  "settings.brandFormSections.colorsTitle": "Cores",
  "settings.brandFormSections.companyNameLabel": "Nome da empresa",
  "settings.brandFormSections.companyNamePlaceholder": "Acme Corp",
  "settings.brandFormSections.companyOverviewTitle":
    "Vis\u00e3o Geral da Empresa",
  "settings.brandFormSections.domainInputPlaceholder": "acme.com",
  "settings.brandFormSections.domainLabel": "Dom\u00ednio",
  "settings.brandFormSections.domainPlaceholder": "acme.com",
  "settings.brandFormSections.extract": "Extrair",
  "settings.brandFormSections.extracting": "Extraindo...",
  "settings.brandFormSections.faviconLabel": "Favicon",
  "settings.brandFormSections.fontFamilyPlaceholder":
    "Fam\u00edlia de fonte para {role}",
  "settings.brandFormSections.fontRoleBody": "Corpo",
  "settings.brandFormSections.fontRoleCode": "C\u00f3digo",
  "settings.brandFormSections.fontRoleHeading": "T\u00edtulos",
  "settings.brandFormSections.fontsTitle": "Fontes",
  "settings.brandFormSections.logoLabel": "Logo",
  "settings.brandFormSections.logosImagesTitle": "Logos e Imagens",
  "settings.brandFormSections.noImageLabel": "Sem {label}",
  "settings.brandFormSections.ogImageLabel": "Imagem SEO / OG",
  "settings.brandFormSections.openLink": "abrir",
  "settings.brandFormSections.overviewLabel": "Vis\u00e3o Geral",
  "settings.brandFormSections.overviewPlaceholder":
    "Breve descri\u00e7\u00e3o do que a empresa faz...",
  "settings.brandFormSections.urlPlaceholder": "https://...",
  "settings.buckets.accessKeyIdLabel": "ID de chave de acesso",
  "settings.buckets.addBucket": "Adicionar bucket",
  "settings.buckets.addBucketButton": "Adicionar bucket",
  "settings.buckets.addS3Bucket": "Adicionar bucket S3",
  "settings.buckets.addingButton": "Adicionando\u2026",
  "settings.buckets.apiKeyHelperText":
    "Enviado como header x-api-key em cada chamada de atualiza\u00e7\u00e3o.",
  "settings.buckets.apiKeyLabel": "Chave API",
  "settings.buckets.bucketAdded": 'Bucket "{name}" adicionado',
  "settings.buckets.bucketLabel": "Bucket",
  "settings.buckets.bucketPlaceholder": "meu-bucket",
  "settings.buckets.bucketRemoved": 'Bucket "{name}" removido',
  "settings.buckets.bucketsConfigured": "{count} bucket(s) configurado(s)",
  "settings.buckets.cancelButton": "Cancelar",
  "settings.buckets.credentialsEncryptedDescription":
    "As credenciais s\u00e3o criptografadas em repouso e nunca retornadas pela API. Para Cloudflare R2, Google Cloud Storage ou MinIO, defina um endpoint personalizado.",
  "settings.buckets.credentialsLabel": "Credenciais",
  "settings.buckets.deleteButton": "Deletar {name}",
  "settings.buckets.descriptionLabel": "Descri\u00e7\u00e3o (opcional)",
  "settings.buckets.descriptionPlaceholder":
    "Para que este bucket \u00e9 usado?",
  "settings.buckets.emptyStateDescription":
    "Adicione um bucket compat\u00edvel com S3 (AWS S3, Cloudflare R2, Google Cloud Storage, MinIO). As chaves de acesso s\u00e3o criptografadas em repouso e nunca retornadas pela API.",
  "settings.buckets.endpointHelperText":
    "Obrigat\u00f3rio para provedores que n\u00e3o s\u00e3o AWS (R2, GCS, MinIO).",
  "settings.buckets.endpointLabel": "Endpoint (opcional)",
  "settings.buckets.endpointPlaceholder":
    "https://<account>.r2.cloudflarestorage.com",
  "settings.buckets.failedToAddBucket": "Falha ao adicionar bucket",
  "settings.buckets.failedToLoadConfigs":
    "Falha ao carregar configura\u00e7\u00f5es de arquivo: {error}",
  "settings.buckets.failedToLoadConfigsFallback":
    "Falha ao carregar configura\u00e7\u00f5es de arquivo",
  "settings.buckets.failedToRemoveBucket": "Falha ao remover bucket",
  "settings.buckets.forcePathStyleHelperText":
    "Obrigat\u00f3rio para Google Cloud Storage e a maioria das configura\u00e7\u00f5es do MinIO.",
  "settings.buckets.forcePathStyleLabel": "For\u00e7ar URLs path-style",
  "settings.buckets.managed": "Gerenciado",
  "settings.buckets.nameHelperText":
    "Letras, d\u00edgitos, underscore, ponto, h\u00edfen. \u00danico dentro da organiza\u00e7\u00e3o.",
  "settings.buckets.nameLabel": "Nome",
  "settings.buckets.namePlaceholder": "production-uploads",
  "settings.buckets.noBucketsConfigured": "Nenhum bucket configurado",
  "settings.buckets.pageTitle": "Buckets",
  "settings.buckets.pathStyle": "path-style",
  "settings.buckets.prefix": "prefixo: {prefix}",
  "settings.buckets.prefixHelperText":
    "Todas as chaves de objeto s\u00e3o escritas sob este prefixo. \u00datil para buckets multi-tenant ou credenciais escopo de um sub-path. Uma barra \u00e0 direita \u00e9 adicionada automaticamente.",
  "settings.buckets.prefixLabel": "Prefixo de chave (opcional)",
  "settings.buckets.prefixPlaceholder": "tenants/acme/",
  "settings.buckets.public": "p\u00fablico: {url}",
  "settings.buckets.publicUrlBaseHelperText":
    "Host usado para construir URLs p\u00fablicas retornadas pelo seletor (dom\u00ednio dev do R2, CDN, host personalizado). Deixe em branco para usar o host S3 do bucket (padr\u00e3o da AWS).",
  "settings.buckets.publicUrlBaseLabel": "Base de URL p\u00fablica (opcional)",
  "settings.buckets.publicUrlBasePlaceholder":
    "https://pub-xxxx.r2.dev ou https://cdn.example.com",
  "settings.buckets.refreshUrlHelperText":
    "Endpoint para o qual \u00e9 feito POST (com a chave API abaixo) para fornecer credenciais tempor\u00e1rias. Deve retornar accessKeyId, secretAccessKey, sessionToken e expiration.",
  "settings.buckets.refreshUrlLabel": "URL de atualiza\u00e7\u00e3o",
  "settings.buckets.refreshUrlPlaceholder":
    "https://admin.example.com/api/acme/s3-credentials",
  "settings.buckets.regionLabel": "Regi\u00e3o",
  "settings.buckets.regionPlaceholder": "us-east-1",
  "settings.buckets.removeBucketDescription":
    "Isto exclui as credenciais criptografadas para {name}. O bucket em si n\u00e3o \u00e9 afetado. Isto n\u00e3o pode ser desfeito.",
  "settings.buckets.removeBucketTitle":
    "Remover configura\u00e7\u00e3o do bucket?",
  "settings.buckets.removeButton": "Remover",
  "settings.buckets.removingButton": "Removendo\u2026",
  "settings.buckets.secretAccessKeyLabel": "Chave de acesso secreta",
  "settings.buckets.staticKeyHelperText":
    "Um ID de chave de acesso de longa dura\u00e7\u00e3o e segredo, usados conforme fornecidos.",
  "settings.buckets.staticKeyOption":
    "Par de chave est\u00e1tica (longa dura\u00e7\u00e3o)",
  "settings.buckets.stsSessionHelperText":
    "Armazena apenas um endpoint de atualiza\u00e7\u00e3o + chave API; credenciais de curta dura\u00e7\u00e3o s\u00e3o buscadas sob demanda e atualizadas automaticamente.",
  "settings.buckets.temporarySessionOption":
    "Sess\u00e3o tempor\u00e1ria (STS, auto-atualizada)",
  "settings.connectForms.apiKeyField": "Chave API",
  "settings.connectForms.baseUrlField": "URL Base",
  "settings.connectForms.baseUrlPlaceholder": "http://localhost:4000/v1",
  "settings.connectForms.cancel": "Cancelar",
  "settings.connectForms.connectionSavedSuccess":
    "Conex\u00e3o salva com sucesso",
  "settings.connectForms.defaultKeyLabel": "Chave pessoal",
  "settings.connectForms.failedSaveConnection":
    "Falha ao salvar conex\u00e3o: {error}",
  "settings.connectForms.failedSaveKey": "Falha ao salvar chave: {error}",
  "settings.connectForms.hideApiKey": "Ocultar chave API",
  "settings.connectForms.keySavedSuccess": "Chave salva com sucesso",
  "settings.connectForms.labelField": "R\u00f3tulo",
  "settings.connectForms.labelPlaceholder": "Ex: Chave pessoal",
  "settings.connectForms.labelPlaceholderOpenAiCompatible":
    "Ex: Meu servidor compat\u00edvel com OpenAI",
  "settings.connectForms.labelPlaceholderPreset": "Ex: {name} prod, {name} dev",
  "settings.connectForms.optional": "opcional",
  "settings.connectForms.recommended": "recomendado",
  "settings.connectForms.saveConnection": "Salvar Conex\u00e3o",
  "settings.connectForms.saveKey": "Salvar Chave",
  "settings.connectForms.saving": "Salvando...",
  "settings.connectForms.showApiKey": "Mostrar chave API",
  "settings.connectProviderDialog.backButton": "Voltar",
  "settings.connectProviderDialog.backButtonLabel": "Voltar",
  "settings.connectProviderDialog.connectionTimedOutMessage":
    "Conex\u00e3o expirou",
  "settings.connectProviderDialog.defaultProviderName": "Provedor",
  "settings.connectProviderDialog.defaultTitle": "Conectar um provedor de IA",
  "settings.connectProviderDialog.gridDescription":
    "Escolha um provedor \u2014 o resto a gente resolve.",
  "settings.connectProviderDialog.oauthFailedMessage":
    "Falha na conex\u00e3o OAuth: {error}",
  "settings.connectProviderDialog.oauthPendingMessage":
    "Autorize a conex\u00e3o na janela de pop-up. Este chat ser\u00e1 fechado quando a autoriza\u00e7\u00e3o for conclu\u00edda.",
  "settings.connectProviderDialog.oauthSuccessMessage":
    "{provider} conectado com sucesso",
  "settings.connectProviderDialog.provisionPendingMessage": "Conectando\u2026",
  "settings.connectProviderDialog.provisionSuccessMessage":
    "{provider} conectado com sucesso",
  "settings.connectProviderDialog.retryButton": "Tentar novamente",
  "settings.connectProviderDialog.securityCheckFailedMessage":
    "Falha na verifica\u00e7\u00e3o de seguran\u00e7a: Token de estado n\u00e3o corresponde",
  "settings.connectProviderDialog.startOAuthFailedMessage":
    "Falha ao iniciar OAuth: {error}",
  "settings.connectedProvidersSection.connectButton": "Conectar provedor",
  "settings.connectedProvidersSection.emptyState":
    "Traga suas pr\u00f3prias chaves para usar modelos espec\u00edficos junto com o gateway da Deco.",
  "settings.connectedProvidersSection.sectionTitle": "Provedores conectados",
  "settings.claudeSubscription.active":
    "Seu plano Claude est\u00e1 executando estas tarefas de c\u00f3digo.",
  "settings.claudeSubscription.connect": "Vincular",
  "settings.claudeSubscription.connected": "Assinatura Claude conectada",
  "settings.claudeSubscription.description":
    "Execute tarefas de c\u00f3digo no seu pr\u00f3prio plano Claude Pro ou Max, em vez do cr\u00e9dito de IA da organiza\u00e7\u00e3o.",
  "settings.claudeSubscription.disconnect": "Desconectar",
  "settings.claudeSubscription.disconnected": "Assinatura Claude desconectada",
  "settings.claudeSubscription.expired":
    "A Anthropic n\u00e3o aceita mais seu token. Gere um novo para continuar usando seu plano.",
  "settings.claudeSubscription.howTo":
    "Gere um token na sua pr\u00f3pria m\u00e1quina com",
  "settings.claudeSubscription.title": "Sua assinatura Claude",
  "settings.claudeSubscription.tokenPlaceholder": "Cole seu token",
  "settings.decoCreditsHero.accessModels": "Acesso a 100+ modelos",
  "settings.decoCreditsHero.add": "Adicionar",
  "settings.decoCreditsHero.addCredits": "Adicionar cr\u00e9ditos",
  "settings.decoCreditsHero.amountPlaceholder": "50",
  "settings.decoCreditsHero.availableBalance":
    "Saldo de cr\u00e9dito dispon\u00edvel",
  "settings.decoCreditsHero.cancel": "Cancelar",
  "settings.decoCreditsHero.cancelButton": "Cancelar",
  "settings.decoCreditsHero.custom": "Personalizado",
  "settings.decoCreditsHero.decoAiGatewayAlt": "Deco AI Gateway",
  "settings.decoCreditsHero.disconnect": "Desconectar",
  "settings.decoCreditsHero.disconnectButton": "Desconectar",
  "settings.decoCreditsHero.disconnectDescription":
    "Isso remover\u00e1 o Deco AI Gateway deste espa\u00e7o de trabalho. Seu saldo de cr\u00e9dito \u00e9 preservado e estar\u00e1 dispon\u00edvel se voc\u00ea se reconectar.",
  "settings.decoCreditsHero.disconnectError": "Falha ao desconectar: {message}",
  "settings.decoCreditsHero.disconnectSuccess": "Deco AI Gateway desconectado",
  "settings.decoCreditsHero.disconnectTitle": "Desconectar Deco AI Gateway",
  "settings.decoCreditsHero.refreshBalance": "Atualizar saldo",
  "settings.decoCreditsHero.title": "Deco AI Gateway",
  "settings.decoCreditsHero.topUpFailed": "Recarga falhou: {message}",
  "settings.decoNudgeCard.connectDeco": "Conectar Deco",
  "settings.decoNudgeCard.connecting": "Conectando\u2026",
  "settings.decoNudgeCard.decoAiGateway": "Deco AI Gateway",
  "settings.decoNudgeCard.description":
    "100+ modelos, uma conex\u00e3o \u2014 pague conforme usa, sem APIs para gerenciar.",
  "settings.decoNudgeCard.recommended": "Recomendado",
  "settings.deleteOrganizationSection.cancel": "Cancelar",
  "settings.deleteOrganizationSection.dangerZone": "Zona de Risco",
  "settings.deleteOrganizationSection.deleteButton": "Deletar",
  "settings.deleteOrganizationSection.deleteOrganizationAction":
    "Deletar organiza\u00e7\u00e3o",
  "settings.deleteOrganizationSection.deleteOrganizationDescription":
    "Delete permanentemente esta organiza\u00e7\u00e3o e todos os seus dados. Esta a\u00e7\u00e3o n\u00e3o pode ser desfeita.",
  "settings.deleteOrganizationSection.deleteOrganizationQuestion":
    "Deletar Organiza\u00e7\u00e3o?",
  "settings.deleteOrganizationSection.deleteOrganizationTitle":
    "Deletar organiza\u00e7\u00e3o",
  "settings.deleteOrganizationSection.deleteWarning":
    "Isto ir\u00e1 deletar permanentemente todos os dados associados com {organizationName}. Esta a\u00e7\u00e3o n\u00e3o pode ser desfeita.",
  "settings.deleteOrganizationSection.deleting": "Deletando\u2026",
  "settings.deleteOrganizationSection.failedToDeleteOrganization":
    "Falha ao deletar organiza\u00e7\u00e3o",
  "settings.deleteOrganizationSection.irreversibleActionsDescription":
    "A\u00e7\u00f5es irrevers\u00edveis que afetam toda a sua organiza\u00e7\u00e3o.",
  "settings.deleteOrganizationSection.organizationDeleted":
    "Organiza\u00e7\u00e3o deletada",
  "settings.deleteOrganizationSection.typeToConfirm":
    "Digite {organizationName} para confirmar:",
  "settings.domainSettings.addDnsRecordInstruction":
    "Adicione o registro DNS abaixo e verifique.",
  "settings.domainSettings.addDomain": "Adicionar dom\u00ednio",
  "settings.domainSettings.adding": "Adicionando\u2026",
  "settings.domainSettings.copied": "Copiado",
  "settings.domainSettings.dnsInstructions":
    "Adicione este registro TXT no seu provedor de DNS e clique em Verificar:",
  "settings.domainSettings.domainAdded": "Dom\u00ednio adicionado",
  "settings.domainSettings.domainPlaceholder": "acme.com",
  "settings.domainSettings.domainRemoved": "Dom\u00ednio removido",
  "settings.domainSettings.domainVerified": "Dom\u00ednio verificado",
  "settings.domainSettings.emailDomains": "Dom\u00ednios de e-mail",
  "settings.domainSettings.emailDomainsDescription":
    "Permita que pessoas com um dom\u00ednio de e-mail correspondente descubram e se juntem a esta organiza\u00e7\u00e3o.",
  "settings.domainSettings.failedAddDomain": "Falha ao adicionar dom\u00ednio",
  "settings.domainSettings.failedRemove": "Falha ao remover",
  "settings.domainSettings.failedUpdate": "Falha ao atualizar",
  "settings.domainSettings.failedVerify": "Falha ao verificar",
  "settings.domainSettings.joinMode": "Modo de entrada",
  "settings.domainSettings.joinModeAuto": "Entrada autom\u00e1tica",
  "settings.domainSettings.joinModeHelpAuto":
    "Qualquer pessoa com um e-mail @{domain} verificado entra automaticamente.",
  "settings.domainSettings.joinModeHelpOff":
    "N\u00e3o detect\u00e1vel \u2014 ningu\u00e9m pode encontrar ou se juntar atrav\u00e9s deste dom\u00ednio.",
  "settings.domainSettings.joinModeHelpRequest":
    "Pessoas com um e-mail @{domain} verificado podem solicitar entrada; um administrador aprova.",
  "settings.domainSettings.joinModeOff": "Desativado",
  "settings.domainSettings.joinModeRequest": "Requer aprova\u00e7\u00e3o",
  "settings.domainSettings.joinModeUpdated": "Modo de entrada atualizado",
  "settings.domainSettings.pending": "Pendente",
  "settings.domainSettings.remove": "Remover",
  "settings.domainSettings.txt": "TXT",
  "settings.domainSettings.txtRecordNotFound":
    "Registro TXT n\u00e3o encontrado ainda \u2014 o DNS pode levar alguns minutos.",
  "settings.domainSettings.value": "valor",
  "settings.domainSettings.verified": "Verificado",
  "settings.domainSettings.verify": "Verificar",
  "settings.editProviderDialog.apiKey": "Chave de API",
  "settings.editProviderDialog.apiKeyRequiredForBaseUrlChange":
    "Informe a chave de API novamente para confirmar a mudança da URL base",
  "settings.editProviderDialog.baseUrl": "URL base",
  "settings.editProviderDialog.baseUrlPlaceholder": "http://localhost:4000/v1",
  "settings.editProviderDialog.cancel": "Cancelar",
  "settings.editProviderDialog.editTitle": "Editar {name}",
  "settings.editProviderDialog.failedToUpdate": "Falha ao atualizar: {error}",
  "settings.editProviderDialog.hideApiKey": "Ocultar chave de API",
  "settings.editProviderDialog.label": "R\u00f3tulo",
  "settings.editProviderDialog.labelPlaceholder": "p.ex. Chave pessoal",
  "settings.editProviderDialog.labelRequired":
    "R\u00f3tulo \u00e9 obrigat\u00f3rio",
  "settings.editProviderDialog.leaveBlankHint":
    "deixe em branco para manter atual",
  "settings.editProviderDialog.providerUpdated": "Provedor atualizado",
  "settings.editProviderDialog.save": "Salvar",
  "settings.editProviderDialog.saving": "Salvando...",
  "settings.editProviderDialog.showApiKey": "Mostrar chave de API",
  "settings.joinRequestsSection.approve": "Aprovar",
  "settings.joinRequestsSection.deny": "Recusar",
  "settings.joinRequestsSection.description":
    "Pessoas que solicitaram entrada por um dom\u00ednio em modo de aprova\u00e7\u00e3o.",
  "settings.joinRequestsSection.title": "Solicita\u00e7\u00f5es de entrada",
  "settings.orgBrandContext.addBrand": "Adicionar Marca",
  "settings.orgBrandContext.addYourFirstBrand": "Adicionar sua primeira marca",
  "settings.orgBrandContext.brandContext": "Contexto de Marca",
  "settings.orgBrandContext.brandContextDescription":
    "Defina seus perfis de marca. Cada marca est\u00e1 dispon\u00edvel como um prompt MCP para clientes de IA.",
  "settings.orgBrandContext.brandContextUpdated":
    "Contexto de marca atualizado com sucesso",
  "settings.orgBrandContext.brandCreated": "Marca criada",
  "settings.orgBrandContext.brandDeleted": "Marca exclu\u00edda",
  "settings.orgBrandContext.brandExtractedSuccessfully":
    "Marca extra\u00edda com sucesso",
  "settings.orgBrandContext.cancel": "Cancelar",
  "settings.orgBrandContext.delete": "Excluir",
  "settings.orgBrandContext.deleteBrand": "Excluir marca",
  "settings.orgBrandContext.deleteBrandTitle": "Excluir marca?",
  "settings.orgBrandContext.deleteConfirmMessage":
    "Isso excluir\u00e1 permanentemente {name}. Esta a\u00e7\u00e3o n\u00e3o pode ser desfeita.",
  "settings.orgBrandContext.deleteDefaultBrandWarning":
    "esta \u00e9 a marca padr\u00e3o da sua organiza\u00e7\u00e3o. Exclu\u00ed-la deixar\u00e1 sua organiza\u00e7\u00e3o sem uma marca padr\u00e3o at\u00e9 que voc\u00ea defina outra.",
  "settings.orgBrandContext.deleting": "Excluindo...",
  "settings.orgBrandContext.failedCreateBrand": "Falha ao criar marca",
  "settings.orgBrandContext.failedDeleteBrand": "Falha ao excluir marca",
  "settings.orgBrandContext.failedExtractBrand": "Falha ao extrair marca",
  "settings.orgBrandContext.failedSaveBrandContext":
    "Falha ao salvar contexto de marca",
  "settings.orgBrandContext.failedUpdateDefaultBrand":
    "Falha ao atualizar marca padr\u00e3o",
  "settings.orgBrandContext.headsUp": "Aten\u00e7\u00e3o",
  "settings.orgBrandContext.noBrandsConfigured":
    "Nenhuma marca configurada ainda.",
  "settings.orgBrandContext.removedAsDefaultBrand":
    "Removido como marca padr\u00e3o",
  "settings.orgBrandContext.setAsDefault": "Definir como padr\u00e3o",
  "settings.orgBrandContext.setAsDefaultBrand":
    "Definir como marca padr\u00e3o",
  "settings.orgBrandContext.thisBrand": "esta marca",
  "settings.orgBrandContext.unsetAsDefault": "Remover como padr\u00e3o",
  "settings.orgBrandContext.untitledBrand": "Marca Sem T\u00edtulo",
  "settings.orgGeneral.organization": "Organiza\u00e7\u00e3o",
  "settings.mainAgent.title": "Agente principal",
  "settings.mainAgent.description":
    "O agente em que esta organiza\u00e7\u00e3o abre. Todos os membros chegam aqui em vez do Super Agent.",
  "settings.mainAgent.itemTitle": "Agente de entrada",
  "settings.mainAgent.itemDescription":
    "Escolha o agente que abre ao entrar nesta organiza\u00e7\u00e3o.",
  "settings.mainAgent.superAgentOption": "Super Agent (padr\u00e3o)",
  "settings.mainAgent.setToast": '"{title}" agora \u00e9 o agente principal',
  "settings.mainAgent.resetToast": "Redefinido para o Super Agent",
  "settings.mainAgent.errorToast":
    "N\u00e3o foi poss\u00edvel atualizar o agente principal",
  "settings.review.title": "Revisores e merge",
  "settings.review.description":
    "Revisores autom\u00e1ticos rodam no pull request de uma tarefa assim que ela entra em Revis\u00e3o (checks passando ou inexistentes). Ambos aparecem como sess\u00f5es no card da tarefa.",
  "settings.review.qaAgentTitle": "Ativar QA Agent",
  "settings.review.qaAgentDescription":
    "Garante que a tarefa realmente resolveu o problema \u2014 testa a feature, n\u00e3o s\u00f3 o diff.",
  "settings.review.codeReviewerTitle": "Ativar Code Reviewer",
  "settings.review.codeReviewerDescription":
    "Revisa o c\u00f3digo usando as skills de review apropriadas \u00e0 stack do reposit\u00f3rio.",
  "settings.review.autoMergeTitle": "Ativar Auto-merge",
  "settings.review.autoMergeDescription":
    "Quando todos os revisores habilitados aprovam, mescla o pull request automaticamente em vez de esperar por uma pessoa. Se um conflito bloquear o merge, o Super Agent resolve antes.",
  "settings.review.autoAssignReportTasksTitle":
    "Atribuir tarefas de relat\u00f3rio ao Super Agent automaticamente",
  "settings.review.autoAssignReportTasksDescription":
    "Tarefas criadas a partir de um relat\u00f3rio s\u00e3o delegadas ao Super Agent automaticamente, em vez de ficarem sem respons\u00e1vel.",
  "settings.review.updateError":
    "N\u00e3o foi poss\u00edvel atualizar a configura\u00e7\u00e3o",
  "settings.orgRoleDetail.addMember": "Adicionar Membro",
  "settings.orgRoleDetail.addMembersToGrantPermissions":
    "Adicione membros para conceder as permiss\u00f5es configuradas.",
  "settings.orgRoleDetail.addMembersToRole": "Adicionar Membros ao Papel",
  "settings.orgRoleDetail.addWithCount": "Adicionar ({count})",
  "settings.orgRoleDetail.added": "Adicionado",
  "settings.orgRoleDetail.allModels": "Todos os modelos",
  "settings.orgRoleDetail.allOrgPermissions":
    "Todas as permiss\u00f5es da organiza\u00e7\u00e3o",
  "settings.orgRoleDetail.builtinRolePermissionsCannotBeChanged":
    "Permiss\u00f5es de papel integrado n\u00e3o podem ser alteradas",
  "settings.orgRoleDetail.cancel": "Cancelar",
  "settings.orgRoleDetail.createRole": "Criar Papel",
  "settings.orgRoleDetail.enabledCount": "{enabledCount}/{total} ativados",
  "settings.orgRoleDetail.failedToSaveRole": "Falha ao salvar papel",
  "settings.orgRoleDetail.general": "Geral",
  "settings.orgRoleDetail.grantFullAccessToAllFeaturesBelow":
    "Conceder acesso completo a todos os recursos abaixo",
  "settings.orgRoleDetail.loadingModels": "Carregando modelos...",
  "settings.orgRoleDetail.mcpPermissions": "Permiss\u00f5es MCP",
  "settings.orgRoleDetail.members": "Membros",
  "settings.orgRoleDetail.membersUpdatedSuccessfully":
    "Membros atualizados com sucesso!",
  "settings.orgRoleDetail.models": "Modelos",
  "settings.orgRoleDetail.noLlmConnectionsConfigured":
    "Nenhuma conex\u00e3o LLM configurada",
  "settings.orgRoleDetail.noMembers": "Sem membros",
  "settings.orgRoleDetail.noMembersAvailable": "Nenhum membro dispon\u00edvel",
  "settings.orgRoleDetail.noMembersFound": "Nenhum membro encontrado",
  "settings.orgRoleDetail.noMembersMatch":
    'Nenhum membro corresponde a "{searchQuery}"',
  "settings.orgRoleDetail.noPermissionsMatch":
    'Nenhuma permiss\u00e3o corresponde a "{searchQuery}"',
  "settings.orgRoleDetail.organizationPermissions":
    "Permiss\u00f5es da Organiza\u00e7\u00e3o",
  "settings.orgRoleDetail.owner": "Propriet\u00e1rio",
  "settings.orgRoleDetail.ownerMembershipCannotBeChanged":
    "A associa\u00e7\u00e3o de propriet\u00e1rio n\u00e3o pode ser alterada",
  "settings.orgRoleDetail.removeMember": "Remover {name} do papel",
  "settings.orgRoleDetail.roleCreatedSuccessfully": "Papel criado com sucesso!",
  "settings.orgRoleDetail.roleName": "Nome do papel",
  "settings.orgRoleDetail.roleNameIsRequired":
    "Nome do papel \u00e9 obrigat\u00f3rio",
  "settings.orgRoleDetail.roleUpdatedSuccessfully":
    "Papel atualizado com sucesso!",
  "settings.orgRoleDetail.saveChanges": "Salvar Altera\u00e7\u00f5es",
  "settings.orgRoleDetail.saving": "Salvando...",
  "settings.orgRoleDetail.searchMcpServers": "Procurar servidores MCP...",
  "settings.orgRoleDetail.searchMembers": "Procurar membros...",
  "settings.orgRoleDetail.searchModels": "Procurar modelos...",
  "settings.orgRoleDetail.searchPermissions": "Procurar permiss\u00f5es...",
  "settings.orgRoleDetail.selectMembersToAddToThisRole":
    "Selecione membros para adicionar a este papel.",
  "settings.orgRoleDetail.showMore": "Mostrar mais ({remaining} restantes)",
  "settings.orgRoleDetail.somethingWentWrong": "Algo deu errado",
  "settings.orgRoleDetail.unknown": "Desconhecido",
  "settings.orgRoleDetail.userIsDefaultRoleMessage":
    "Usu\u00e1rio \u00e9 o papel padr\u00e3o \u2014 membros n\u00e3o podem ser removidos dele; atribua outro papel para alterar seu acesso",
  "settings.orgSso.cancelButton": "Cancelar",
  "settings.orgSso.clientIdLabel": "ID do Cliente",
  "settings.orgSso.clientIdPlaceholder": "seu-id-cliente",
  "settings.orgSso.clientSecretEditDescription":
    "Deixe em branco para manter atual",
  "settings.orgSso.clientSecretLabel": "Senha do Cliente",
  "settings.orgSso.clientSecretPlaceholder": "sua-senha-cliente",
  "settings.orgSso.clientSecretRequiredError":
    "Senha do Cliente \u00e9 obrigat\u00f3ria para a configura\u00e7\u00e3o inicial",
  "settings.orgSso.configurationRemovedSuccess":
    "Configura\u00e7\u00e3o SSO removida",
  "settings.orgSso.configurationSavedSuccess":
    "Configura\u00e7\u00e3o SSO salva",
  "settings.orgSso.configureSsoButton": "Configurar SSO",
  "settings.orgSso.discoveryEndpointDescription":
    "Opcional \u2014 detectado automaticamente do issuer se omitido.",
  "settings.orgSso.discoveryEndpointLabel": "Endpoint de Descoberta",
  "settings.orgSso.discoveryEndpointPlaceholder":
    "Detectado automaticamente do issuer",
  "settings.orgSso.domainLabel": "Dom\u00ednio",
  "settings.orgSso.editConfigButton": "Editar configura\u00e7\u00e3o",
  "settings.orgSso.emailDomainDescription":
    "O dom\u00ednio de e-mail que este provedor SSO cobre.",
  "settings.orgSso.emailDomainLabel": "Dom\u00ednio de E-mail",
  "settings.orgSso.emailDomainPlaceholder": "empresa.com",
  "settings.orgSso.enforceSsoDescription":
    "Exigir que todos os membros se autentiquem via SSO",
  "settings.orgSso.enforceSsoLabel": "For\u00e7ar SSO",
  "settings.orgSso.enforcementDisabledSuccess":
    "Aplica\u00e7\u00e3o de SSO desativada",
  "settings.orgSso.enforcementEnabledSuccess":
    "Aplica\u00e7\u00e3o de SSO ativada",
  "settings.orgSso.issuerUrlDescription":
    "A URL do issuer OIDC do seu provedor de identidade.",
  "settings.orgSso.issuerUrlLabel": "URL do Issuer",
  "settings.orgSso.issuerUrlPlaceholder":
    "https://login.microsoftonline.com/{tenant}/v2.0",
  "settings.orgSso.loading": "Carregando...",
  "settings.orgSso.providerLabel": "Provedor",
  "settings.orgSso.removeButton": "Remover",
  "settings.orgSso.removeConfirmation":
    "Tem certeza de que deseja remover a configura\u00e7\u00e3o SSO?",
  "settings.orgSso.removeSsoConfigError":
    "Falha ao remover configura\u00e7\u00e3o SSO",
  "settings.orgSso.requiredFieldsError":
    "Issuer, ID do Cliente e Dom\u00ednio s\u00e3o obrigat\u00f3rios",
  "settings.orgSso.saveSsoConfigError":
    "Falha ao salvar configura\u00e7\u00e3o SSO",
  "settings.orgSso.savingButton": "Salvando...",
  "settings.orgSso.scopesLabel": "Escopos",
  "settings.orgSso.scopesPlaceholder": "openid email profile",
  "settings.orgSso.sectionTitle": "Single Sign-On",
  "settings.orgSso.securityTitle": "Seguran\u00e7a",
  "settings.orgSso.testSsoButton": "Testar SSO",
  "settings.orgSso.toggleEnforcementError":
    "Falha ao alternar aplica\u00e7\u00e3o de SSO",
  "settings.orgSso.updateButton": "Atualizar",
  "settings.orgStore.addRegistry": "Adicionar Registro",
  "settings.orgStore.adding": "Adicionando...",
  "settings.orgStore.authTokenLabel": "Token de Autentica\u00e7\u00e3o",
  "settings.orgStore.authTokenPlaceholder": "Token Bearer...",
  "settings.orgStore.cancel": "Cancelar",
  "settings.orgStore.communityRegistryDescription":
    "Registro MCP da comunidade com milhares de MCPs \u00fateis",
  "settings.orgStore.communityRegistryNotAdded":
    "Registro MCP da comunidade \u2014 ainda n\u00e3o adicionado",
  "settings.orgStore.communitySection": "Comunidade",
  "settings.orgStore.connectionNotFound":
    "Conex\u00e3o n\u00e3o encontrada \u2014 ser\u00e1 criada automaticamente.",
  "settings.orgStore.decoStoreDescription":
    "Registro MCP deco oficial com integra\u00e7\u00f5es selecionadas",
  "settings.orgStore.decoStoreName": "Loja Deco",
  "settings.orgStore.decoStoreSection": "Loja Deco",
  "settings.orgStore.failedAddRegistry": "Falha ao adicionar registro: {error}",
  "settings.orgStore.failedLoadStoreSettings":
    "Falha ao carregar configura\u00e7\u00f5es da loja:",
  "settings.orgStore.mcpRegistry": "Registro MCP",
  "settings.orgStore.nameLabel": "Nome",
  "settings.orgStore.namePlaceholder": "p.ex. Registro Acme Corp",
  "settings.orgStore.optional": "Opcional",
  "settings.orgStore.pageTitle": "Loja",
  "settings.orgStore.privateMcpRegistry": "Registro MCP privado",
  "settings.orgStore.privateRegistriesSection": "Registros Privados",
  "settings.orgStore.privateRegistry": "Registro Privado",
  "settings.orgStore.privateRegistryAdded": "Registro privado adicionado",
  "settings.orgStore.privateRegistryDescription":
    "Registro MCP privado da sua organiza\u00e7\u00e3o",
  "settings.orgStore.registryUrlLabel": "URL do Registro",
  "settings.orgStore.registryUrlPlaceholder":
    "https://registry.exemplo.com/mcp",
  "settings.orgStore.remove": "Remover",
  "settings.orgStore.removeRegistry": "Remover este registro?",
  "settings.organizationForm.failedToReadImage": "Falha ao ler imagem",
  "settings.organizationForm.failedToUpdateOrg":
    "Falha ao atualizar organiza\u00e7\u00e3o",
  "settings.organizationForm.imageTooLarge": "Imagem deve ser menor que 2MB",
  "settings.organizationForm.logoDescription":
    "Tamanho recomendado \u00e9 256x256px",
  "settings.organizationForm.logoTitle": "Logo",
  "settings.organizationForm.namePlaceholder": "Nome da organiza\u00e7\u00e3o",
  "settings.organizationForm.nameTitle": "Nome",
  "settings.organizationForm.updateSuccess":
    "Organiza\u00e7\u00e3o atualizada com sucesso",
  "settings.organizationForm.uploadLogoLabel":
    "Enviar logo da organiza\u00e7\u00e3o",
  "settings.organizationForm.urlDescription":
    "N\u00e3o pode ser alterada \u2014 \u00e9 usada em URLs e integra\u00e7\u00f5es de API.",
  "settings.organizationForm.urlTitle": "URL",
  "settings.providerKeyRow.addedTimeAgo": "{label} · adicionada há {time}",
  "settings.providerKeyRow.cancel": "Cancelar",
  "settings.providerKeyRow.claudeCode": "Claude Code",
  "settings.providerKeyRow.codex": "Codex",
  "settings.providerKeyRow.delete": "Excluir",
  "settings.providerKeyRow.deleteApiKey": "Excluir chave de API",
  "settings.providerKeyRow.deleteProviderKey": "Excluir chave do provedor",
  "settings.providerKeyRow.editProviderKey": "Editar chave do provedor",
  "settings.providerKeyRow.failedToDeleteKey":
    "Falha ao excluir chave: {error}",
  "settings.providerKeyRow.keyDeleted": "Chave exclu\u00edda",
  "settings.roles.allConnections": "Todas as conex\u00f5es",
  "settings.roles.basicAccess": "Acesso b\u00e1sico",
  "settings.roles.builtIn": "Integrada",
  "settings.roles.cancel": "Cancelar",
  "settings.roles.columnMembers": "Membros",
  "settings.roles.columnPermissions": "Permiss\u00f5es",
  "settings.roles.columnRole": "Fun\u00e7\u00e3o",
  "settings.roles.columnType": "Tipo",
  "settings.roles.connectionCount": "{count} conex\u00e3o(\u00f5es)",
  "settings.roles.createRole": "Criar Fun\u00e7\u00e3o",
  "settings.roles.createRoleGetStarted":
    "Crie uma fun\u00e7\u00e3o para come\u00e7ar.",
  "settings.roles.custom": "Personalizada",
  "settings.roles.delete": "Excluir",
  "settings.roles.deleteRoleConfirm":
    'Tem certeza que deseja excluir a fun\u00e7\u00e3o "{role}"? Esta a\u00e7\u00e3o n\u00e3o pode ser desfeita.',
  "settings.roles.deleteRoleTitle": "Excluir Fun\u00e7\u00e3o",
  "settings.roles.deletedSuccessfully":
    "Fun\u00e7\u00e3o exclu\u00edda com sucesso!",
  "settings.roles.failedToLoad": "Falha ao carregar fun\u00e7\u00f5es",
  "settings.roles.fullAccess": "Acesso completo",
  "settings.roles.fullOrgAccess": "Acesso completo da organiza\u00e7\u00e3o",
  "settings.roles.noPermissions": "Sem permiss\u00f5es",
  "settings.roles.noRoles": "Sem fun\u00e7\u00f5es",
  "settings.roles.noRolesFound": "Nenhuma fun\u00e7\u00e3o encontrada",
  "settings.roles.noRolesMatchSearch":
    'Nenhuma fun\u00e7\u00e3o corresponde a "{search}"',
  "settings.roles.orgPermsCount": "{count} permiss\u00e3o(\u00f5es) da org",
  "settings.roles.pageTitle": "Fun\u00e7\u00f5es",
  "settings.roles.roleAdmin": "Administrador",
  "settings.roles.roleOwner": "Propriet\u00e1rio",
  "settings.roles.roleUser": "Usu\u00e1rio",
  "settings.roles.searchPlaceholder": "Pesquisar fun\u00e7\u00f5es...",
  "settings.secrets.cancelButton": "Cancelar",
  "settings.secrets.createButton": "Criar segredo",
  "settings.secrets.creatingButton": "Criando\u2026",
  "settings.secrets.descriptionLabel": "Descri\u00e7\u00e3o (opcional)",
  "settings.secrets.descriptionPlaceholder":
    "Para que \u00e9 usado este segredo?",
  "settings.secrets.emptyDescription":
    "Armazene chaves de API, tokens e outros valores sens\u00edveis. Os valores s\u00e3o criptografados em repouso e nunca retornados pela API.",
  "settings.secrets.emptyTitle": "Nenhum segredo ainda",
  "settings.secrets.failedToCreateSecret": "Falha ao criar segredo",
  "settings.secrets.failedToLoadError": "Falha ao carregar segredos: {error}",
  "settings.secrets.nameHelp":
    "Letras, d\u00edgitos, sublinhado, ponto, h\u00edfen. Sem distin\u00e7\u00e3o entre mai\u00fasculas e min\u00fasculas dentro do seu escopo.",
  "settings.secrets.nameLabel": "Nome",
  "settings.secrets.namePlaceholder": "STRIPE_API_KEY",
  "settings.secrets.newSecret": "Novo segredo",
  "settings.secrets.newSecretDescription":
    "Armazenado criptografado no cofre de credenciais. Escolha quem pode l\u00ea-lo.",
  "settings.secrets.newSecretTitle": "Novo segredo",
  "settings.secrets.scopeLabel": "Escopo",
  "settings.secrets.scopeOrganization": "Organiza\u00e7\u00e3o",
  "settings.secrets.scopeOrganizationDescription":
    "Organiza\u00e7\u00e3o \u2014 vis\u00edvel para todos os membros",
  "settings.secrets.scopePrivate": "Privado",
  "settings.secrets.scopePrivateDescription":
    "Privado \u2014 vis\u00edvel apenas para mim",
  "settings.secrets.secretCreated": 'Segredo "{name}" criado',
  "settings.secrets.secretsCountSingular": "{count} segredo armazenado",
  "settings.secrets.secretsCountPlural": "{count} segredos armazenados",
  "settings.secrets.sectionOrganization": "Organiza\u00e7\u00e3o",
  "settings.secrets.sectionPrivate": "Privado para mim",
  "settings.secrets.valueLabel": "Valor",
  "settings.simpleModeSection.defaultModels": "Modelos padr\u00e3o",
  "settings.simpleModeSection.failedToSave": "Falha ao salvar: {error}",
  "settings.simpleModeSection.modelsPowerDescription":
    "Estes modelos alimentam chat, automa\u00e7\u00f5es e ferramentas em toda a sua organiza\u00e7\u00e3o.",
  "settings.simpleModeSection.notAvailableWithCurrentProvider":
    "N\u00e3o dispon\u00edvel com o provedor atual",
  "settings.simpleModeSection.pickModel": "Escolher modelo",
  "settings.simpleModeSection.saved": "Salvo",
  "settings.simpleModeSection.saving": "Salvando\u2026",
  "settings.simpleModeSection.tierDeepResearch": "Pesquisa aprofundada",
  "settings.simpleModeSection.tierDeepResearchDesc":
    "Relat\u00f3rios de pesquisa aprofundados e multi-fonte",
  "settings.simpleModeSection.tierFast": "R\u00e1pido",
  "settings.simpleModeSection.tierFastDesc":
    "Respostas mais r\u00e1pidas, ideal para tarefas r\u00e1pidas",
  "settings.simpleModeSection.tierImage": "Imagem",
  "settings.simpleModeSection.tierImageDesc": "Gera\u00e7\u00e3o de imagens",
  "settings.simpleModeSection.tierSmart": "Inteligente",
  "settings.simpleModeSection.tierSmartDesc":
    "Equil\u00edbrio entre velocidade e capacidade",
  "settings.simpleModeSection.tierThinking": "Reflexivo",
  "settings.simpleModeSection.tierThinkingDesc":
    "Mais capaz, ideal para tarefas complexas",
  "settings.simpleModeSection.tierWebSearch": "Busca na web",
  "settings.simpleModeSection.tierWebSearchDesc":
    "Respostas r\u00e1pidas e atualizadas da web",
  "settings.aiProviders.recommended":
    "Recomendado \u2014 100+ modelos, pague conforme usa",
  "settings.aiProviders.customOpenAiCompatible":
    "OpenAI-compat\u00edvel personalizado",
  "settings.aiProviders.customOpenAiDescription":
    "Traga seu pr\u00f3prio servidor de modelos (avan\u00e7ado)",
  "settings.aiProviders.moreProvidersSingular": "{count} provedor adicional",
  "settings.aiProviders.moreProvidersPlural": "{count} provedores adicionais",
  "settings.billing.title": "Cobrança",
  "settings.billing.autoTasksTitle": "Auto tasks",
  "settings.billing.unlimitedDescription":
    "As execuções de auto tasks são ilimitadas neste deployment. Tasks criadas por você também nunca têm limite.",
  "settings.billing.autoTasksDescriptionTrial":
    "3 execuções grátis vitalícias, depois R$ 250/mês para 10 execuções por ciclo de cobrança.",
  "settings.billing.autoTasksDescriptionSubscribed":
    "10 execuções de auto tasks por ciclo de cobrança. Tasks criadas por você nunca têm limite.",
  "settings.billing.statusTrial": "Teste grátis",
  "settings.billing.statusActive": "Ativa",
  "settings.billing.statusPastDue": "Problema no pagamento",
  "settings.billing.runsUsedLabel": "execuções usadas",
  "settings.billing.renewsOn": "Renova em {date}",
  "settings.billing.subscribeButton": "Assinar",
  "settings.billing.manageButton": "Gerenciar cobrança",
  "settings.billing.checkoutError":
    "Não foi possível iniciar o checkout: {message}",
  "settings.billing.portalError":
    "Não foi possível abrir o portal de cobrança: {message}",
  "settings.experimental.title": "Experimental",
  "settings.experimental.description":
    "Prévias opcionais ainda em construção. Ligue por organização para experimentar.",
  "settings.experimental.taskBasedFlowTitle": "Fluxo por tasks",
  "settings.experimental.taskBasedFlowDescription":
    "Opere inteiramente em termos de Tasks e esconda os detalhes de Git (branches, PRs, sync). Cada mudança começa uma nova Task.",
} satisfies Record<keyof typeof settingsEn, string>;
