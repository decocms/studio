import type { admin as adminEn } from "../en/admin.ts";

export const admin = {
  "admin.copyAgent.agentStep": "2. Agente a copiar",
  "admin.copyAgent.agentSummary": "{connections} conexões",
  "admin.copyAgent.connectionsCopied":
    "Conexões criadas na organização destino",
  "admin.copyAgent.copiedSummary":
    "{connections} conexões copiadas, {reused} conexões nativas reaproveitadas, {secrets} segredos copiados, {prompts} prompts iniciais copiados.",
  "admin.copyAgent.copiedTitle": '"{title}" copiado para {org}',
  "admin.copyAgent.copyAction": 'Copiar "{agent}" para {org}',
  "admin.copyAgent.copyActionIdle": "Copiar agente",
  "admin.copyAgent.copyFailed": "Falha ao copiar o agente",
  "admin.copyAgent.copySucceeded": "Agente copiado",
  "admin.copyAgent.credentialWarning":
    "Tokens de acesso, configuração OAuth e segredos são copiados para a organização destino.",
  "admin.copyAgent.failedLoadAgents": "Falha ao carregar agentes",
  "admin.copyAgent.intro":
    "Copie um agente para outra organização com seu system prompt, as conexões que ele usa e as credenciais delas. Conexões nativas apontam para as da própria organização destino; tudo que não pode ser copiado é listado após a cópia.",
  "admin.copyAgent.noAgents": "Esta organização não tem agentes.",
  "admin.copyAgent.noOrgs": "Nenhuma organização encontrada.",
  "admin.copyAgent.noPrompt": "sem system prompt",
  "admin.copyAgent.pickSourceFirst":
    "Escolha primeiro a organização de origem.",
  "admin.copyAgent.searchOrgs": "Buscar por nome ou slug...",
  "admin.copyAgent.skippedTitle": "{count} itens não foram copiados",
  "admin.copyAgent.sourceStep": "1. Organização de origem",
  "admin.copyAgent.tab": "Copiar agente",
  "admin.copyAgent.targetStep": "3. Organização destino",
  "admin.layout.adminDashboard": "Painel de Administração",
  "admin.layout.adminDashboardArea": "o painel de administração",
  "admin.layout.emailVerificationRequired":
    "Verifique seu endereço de e-mail para acessar o painel de administração.",
  "admin.layout.goHome": "Voltar para início",
  "admin.layout.organizationsTab": "Organizações",
  "admin.layout.restrictedToDashboard":
    "Este painel é restrito a administradores de implantação.",
  "admin.layout.usersTab": "Usuários",
  "admin.orgs.addMember": "Adicionar membro",
  "admin.orgs.addMemberTo": "Adicionar membro para {org}",
  "admin.orgs.adding": "Adicionando...",
  "admin.orgs.cancel": "Cancelar",
  "admin.orgs.created": "Criado",
  "admin.orgs.email": "E-mail",
  "admin.orgs.emailPlaceholder": "usuario@example.com",
  "admin.orgs.failedAddMember": "Falha ao adicionar membro",
  "admin.orgs.failedLoadOrgs": "Falha ao carregar organizações",
  "admin.orgs.failedLoadOrgsDescription":
    "Algo deu errado. Atualize para tentar novamente.",
  "admin.orgs.memberAdded": "{email} adicionado(a) a {org}",
  "admin.orgs.members": "Membros",
  "admin.orgs.noOrgsFound": "Nenhuma organização encontrada",
  "admin.orgs.noOrgsMatchSearch":
    'Nenhuma organização corresponde a "{search}"',
  "admin.orgs.noOrgsYet": "Nenhuma organização existe ainda.",
  "admin.orgs.organization": "Organização",
  "admin.orgs.searchPlaceholder": "Procure organizações por nome ou slug...",
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
} satisfies Record<keyof typeof adminEn, string>;
