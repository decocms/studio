import type { admin as adminEn } from "../en/admin.ts";

export const admin = {
  "admin.layout.adminDashboard": "Painel de Administração",
  "admin.layout.adminDashboardArea": "o painel de administração",
  "admin.layout.emailVerificationRequired":
    "Verifique seu endereço de e-mail para acessar o painel de administração.",
  "admin.layout.goHome": "Voltar para início",
  "admin.layout.organizationsTab": "Organizações",
  "admin.layout.promptsTab": "Prompts dos agentes",
  "admin.layout.restrictedToDashboard":
    "Este painel é restrito a administradores de implantação.",
  "admin.layout.usersTab": "Usuários",
  "admin.orgs.archived": "Arquivada",
  "admin.orgs.notice": "Aviso",
  "admin.orgs.noticeFor": "Aviso de cobrança de {org}",
  "admin.orgs.noticeDescription":
    "Um aviso aparece como banner na org. Um bloqueio substitui a UI da org por este texto e recusa escritas até ser removido — o faturamento continua acessível.",
  "admin.orgs.noticeSeverity": "Severidade",
  "admin.orgs.noticeSeverityWarn": "Aviso",
  "admin.orgs.noticeSeverityBlock": "Bloqueio",
  "admin.orgs.noticeTitle": "Título",
  "admin.orgs.noticeTitlePlaceholder": "Pagamento em atraso",
  "admin.orgs.noticeMessage": "Mensagem",
  "admin.orgs.noticeMessagePlaceholder": "O que os membros da org vão ler.",
  "admin.orgs.noticeCtaLabel": "Texto do botão",
  "admin.orgs.noticeCtaLabelPlaceholder": "Pagar fatura",
  "admin.orgs.noticeCtaUrl": "Link do botão",
  "admin.orgs.noticeCtaIncomplete":
    "Preencha o texto e o link do botão, ou nenhum dos dois.",
  "admin.orgs.noticeSave": "Salvar aviso",
  "admin.orgs.noticeSaving": "Salvando...",
  "admin.orgs.noticeClear": "Remover aviso",
  "admin.orgs.noticeSaved": "Aviso salvo para {org}",
  "admin.orgs.noticeCleared": "Aviso removido de {org}",
  "admin.orgs.failedSaveNotice": "Falha ao salvar o aviso",
  "admin.orgs.failedClearNotice": "Falha ao remover o aviso",
  "admin.orgs.addMember": "Adicionar membro",
  "admin.orgs.addMemberTo": "Adicionar membro para {org}",
  "admin.orgs.adding": "Adicionando...",
  "admin.orgs.cancel": "Cancelar",
  "admin.orgs.created": "Criado",
  "admin.orgs.email": "E-mail",
  "admin.orgs.emailPlaceholder": "usuario@example.com",
  "admin.orgs.add": "Adicionar",
  "admin.orgs.addCustomFlag": "Adicionar flag custom",
  "admin.orgs.customFlagKeyLabel": "Chave da flag custom",
  "admin.orgs.customFlagKeyPlaceholder": "minha_flag_custom",
  "admin.orgs.jsonEditorLabel": "JSON das flags",
  "admin.orgs.duplicateFlagKey": "Essa flag já existe",
  "admin.orgs.failedAddMember": "Falha ao adicionar membro",
  "admin.orgs.failedLoadFlags": "Falha ao carregar flags",
  "admin.orgs.failedLoadOrgs": "Falha ao carregar organizações",
  "admin.orgs.failedSaveFlags": "Falha ao salvar flags",
  "admin.orgs.flagCustom": "Custom",
  "admin.orgs.flagDefaultOn": "Ligada por padrão",
  "admin.orgs.flagInvalid": "Valor inválido",
  "admin.orgs.flagUnset": "Não definida",
  "admin.orgs.flags": "Flags",
  "admin.orgs.flagsDescription":
    "Ative ou desative feature flags desta organização. As alterações são salvas nas configurações da org.",
  "admin.orgs.flagsFor": "Feature flags de {org}",
  "admin.orgs.flagsSaved": "Flags atualizadas para {org}",
  "admin.orgs.flagsViewJson": "JSON",
  "admin.orgs.flagsViewToggles": "Toggles",
  "admin.orgs.invalidFlagKey": "Use snake_case minúsculo (ex.: minha_flag)",
  "admin.orgs.invalidStoredValue":
    "Esta org tem uma flag cujo valor salvo não é true/false. Corrija na visão JSON antes de salvar.",
  "admin.orgs.invalidJson":
    "JSON inválido — esperado chaves snake_case mapeadas para valores booleanos.",
  "admin.orgs.jsonReplaceHint":
    "Isto substitui o objeto de flags inteiro. Remover uma chave a desdefine.",
  "admin.orgs.failedLoadOrgsDescription":
    "Algo deu errado. Atualize para tentar novamente.",
  "admin.orgs.memberAdded": "{email} adicionado(a) a {org}",
  "admin.orgs.members": "Membros",
  "admin.orgs.noOrgsFound": "Nenhuma organização encontrada",
  "admin.orgs.noOrgsMatchSearch":
    'Nenhuma organização corresponde a "{search}"',
  "admin.orgs.noOrgsYet": "Nenhuma organização existe ainda.",
  "admin.orgs.organization": "Organização",
  "admin.orgs.save": "Salvar",
  "admin.orgs.saving": "Salvando...",
  "admin.orgs.searchPlaceholder": "Procure organizações por nome ou slug...",
  "admin.orgs.anotherOrg": "outra organização",
  "admin.orgs.close": "Fechar",
  "admin.orgs.failedAddSite": "Falha ao adicionar site",
  "admin.orgs.failedLoadSites": "Falha ao carregar sites",
  "admin.orgs.failedRemoveSite": "Falha ao remover site",
  "admin.orgs.invalidSiteSlug":
    "Use letras minúsculas, dígitos e hifens (ex.: meu-site)",
  "admin.orgs.loading": "Carregando...",
  "admin.orgs.noSites": "Esta organização não é dona de nenhum site.",
  "admin.orgs.reassignConfirm": "Mover site pra cá",
  "admin.orgs.remove": "Remover",
  "admin.orgs.siteAdded": "{slug} adicionado a {org}",
  "admin.orgs.siteReassigned": "{slug} movido para {org}",
  "admin.orgs.siteReassignWarning":
    '"{slug}" pertence a {owner} e será movido para esta organização.',
  "admin.orgs.siteRemoved": "{slug} removido de {org}",
  "admin.orgs.siteSlugPlaceholder": "meu-site",
  "admin.orgs.sites": "Sites",
  "admin.orgs.sitesDescription":
    "Slugs que esta organização possui. Ser dona de um slug habilita as abas de Hosting, E2E, Analytics e Monitor dele.",
  "admin.orgs.sitesFor": "Posse de sites de {org}",
  "admin.prompts.description":
    "Estes prompts são fixos no código em {repo}. As edições aqui são lidas de {branch} e enviadas de volta como um pull request, usando a conexão do GitHub da sua organização {org}.",
  "admin.prompts.failedToLoadDescription":
    "Verifique se o GitHub está conectado na sua organização ativa e tente novamente.",
  "admin.prompts.failedToLoadTitle": "Falha ao carregar os prompts",
  "admin.prompts.markerMissing":
    'Os marcadores prompt-region de "{id}" não estão neste arquivo — corrija os marcadores no repositório antes de editar aqui.',
  "admin.prompts.openPr": "Abrir pull request ({count})",
  "admin.prompts.opening": "Abrindo...",
  "admin.prompts.prFailed": "Falha ao abrir o pull request",
  "admin.prompts.prOpened": "Pull request #{number} aberto",
  "admin.prompts.prTitleLabel": "Título do pull request",
  "admin.prompts.prTitlePlaceholder":
    "chore(prompts): ajustar a persona do QA Agent",
  "admin.prompts.retry": "Tentar novamente",
  "admin.prompts.viewPr": "Ver",
  "admin.users.columnCreated": "Criado",
  "admin.users.columnEmail": "E-mail",
  "admin.users.columnUser": "Usuário",
  "admin.users.failedToImpersonate": "Falha ao assumir identidade do usuário",
  "admin.users.failedToLoadDescription":
    "Algo deu errado. Atualize a página para tentar novamente.",
  "admin.users.failedToLoadTitle": "Falha ao carregar usuários",
  "admin.users.impersonate": "Assumir identidade",
  "admin.users.noUsersFoundTitle": "Nenhum usuário encontrado",
  "admin.users.noUsersMatchSearch": 'Nenhum usuário corresponde a "{search}"',
  "admin.users.noUsersYet": "Nenhum usuário ainda.",
  "admin.users.searchPlaceholder": "Pesquise usuários por e-mail ou nome...",
  "admin.users.unknown": "Desconhecido",
  "admin.users.unverified": "Não verificado",
  "admin.users.verified": "Verificado",
  "admin.layout.githubTab": "GitHub",
  "admin.github.description":
    "Registre o GitHub App que esta implantação usa para importar repositórios, cloná-los em sandboxes e abrir pull requests. O GitHub cria o App para você — nada para copiar à mão.",
  "admin.github.failedToLoad": "Falha ao carregar o status do GitHub App",
  "admin.github.envTitle": "Configurado por variáveis de ambiente",
  "admin.github.envDescription":
    "As variáveis GITHUB_APP_* definem o App desta implantação e têm prioridade sobre um App registrado aqui.",
  "admin.github.envUnusable":
    "As variáveis GITHUB_APP_* estão definidas, mas a chave privada não consegue assinar. Verifique se as quebras de linha sobreviveram ao cofre de segredos.",
  "admin.github.storedTitle": 'O GitHub App "{slug}" está registrado',
  "admin.github.storedDescription":
    "Os membros já podem conectar o GitHub em Configurações → Repositórios. Instale o App nas contas ou organizações cujos repositórios serão importados.",
  "admin.github.storedUnusable":
    "A chave privada do App salvo não consegue assinar. Registre um novo App abaixo.",
  "admin.github.install": "Instalar em uma conta",
  "admin.github.viewOnGithub": "Ver no GitHub",
  "admin.github.createTitle": "Criar um GitHub App",
  "admin.github.replaceTitle": "Registrar outro App",
  "admin.github.organizationLabel": "Organização do GitHub (opcional)",
  "admin.github.organizationPlaceholder": "acme",
  "admin.github.organizationHint":
    "Deixe vazio para criar o App na sua conta pessoal do GitHub. Você precisa ser owner da organização.",
  "admin.github.nameLabel": "Nome do App",
  "admin.github.publicLabel": "Permitir instalação em qualquer conta do GitHub",
  "admin.github.publicHint":
    "Desligado: só a conta dona do App pode instalá-lo. Ligue se os membros forem importar repositórios de outras contas ou organizações.",
  "admin.github.create": "Criar GitHub App",
  "admin.github.replace": "Criar e substituir",
  "admin.github.redirecting": "Abrindo o GitHub...",
  "admin.github.createFailed":
    "Não foi possível iniciar a configuração do GitHub App",
  "admin.github.publicUrlNote":
    "O GitHub enviará os usuários de volta para {url}. O endereço precisa estar acessível pelos navegadores deles.",
  "admin.github.outcomeCreated":
    "GitHub App criado. Instale-o em uma conta para começar a importar repositórios.",
  "admin.github.outcomeDenied": "A criação do GitHub App foi cancelada.",
  "admin.github.outcomeInvalidState":
    "O link de configuração expirou ou foi adulterado. Comece de novo.",
  "admin.github.outcomeSessionMismatch":
    "Conclua a configuração na mesma sessão do navegador, logado como o admin da implantação que a iniciou.",
  "admin.github.outcomeEnvConfigured":
    "As variáveis de ambiente GITHUB_APP_* estão definidas e têm prioridade; nada foi salvo.",
  "admin.github.outcomeExchangeFailed":
    "O GitHub criou o App, mas o Studio não conseguiu buscar as credenciais. Tente de novo e apague o App não usado no GitHub.",
  "admin.github.remove": "Remover",
  "admin.github.removeTitle": "Remover este GitHub App do Studio?",
  "admin.github.removeDescription":
    "Os membros não poderão mais conectar o GitHub nem clonar por este App. O App continua no GitHub; apague-o lá se não precisar mais dele.",
  "admin.github.cancel": "Cancelar",
  "admin.github.removed": "GitHub App removido",
  "admin.github.removeFailed": "Não foi possível remover o GitHub App",
} satisfies Record<keyof typeof adminEn, string>;
