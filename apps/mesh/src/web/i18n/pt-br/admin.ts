import type { admin as adminEn } from "../en/admin.ts";

export const admin = {
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
