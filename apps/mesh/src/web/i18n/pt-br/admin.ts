import type { admin as adminEn } from "../en/admin.ts";

export const admin = {
  "admin.layout.adminDashboard": "Painel de Administra\u00e7\u00e3o",
  "admin.layout.adminDashboardArea": "o painel de administra\u00e7\u00e3o",
  "admin.layout.emailVerificationRequired":
    "Verifique seu endere\u00e7o de e-mail para acessar o painel de administra\u00e7\u00e3o.",
  "admin.layout.goHome": "Voltar para in\u00edcio",
  "admin.layout.organizationsTab": "Organiza\u00e7\u00f5es",
  "admin.layout.restrictedToDashboard":
    "Este painel \u00e9 restrito a administradores de implanta\u00e7\u00e3o.",
  "admin.layout.usersTab": "Usu\u00e1rios",
  "admin.orgs.addMember": "Adicionar membro",
  "admin.orgs.addMemberTo": "Adicionar membro para {org}",
  "admin.orgs.adding": "Adicionando...",
  "admin.orgs.cancel": "Cancelar",
  "admin.orgs.created": "Criado",
  "admin.orgs.email": "E-mail",
  "admin.orgs.emailPlaceholder": "usuario@example.com",
  "admin.orgs.failedAddMember": "Falha ao adicionar membro",
  "admin.orgs.failedLoadOrgs": "Falha ao carregar organiza\u00e7\u00f5es",
  "admin.orgs.failedLoadOrgsDescription":
    "Algo deu errado. Atualize para tentar novamente.",
  "admin.orgs.memberAdded": "{email} adicionado(a) a {org}",
  "admin.orgs.members": "Membros",
  "admin.orgs.noOrgsFound": "Nenhuma organiza\u00e7\u00e3o encontrada",
  "admin.orgs.noOrgsMatchSearch":
    'Nenhuma organiza\u00e7\u00e3o corresponde a "{search}"',
  "admin.orgs.noOrgsYet": "Nenhuma organiza\u00e7\u00e3o existe ainda.",
  "admin.orgs.organization": "Organiza\u00e7\u00e3o",
  "admin.orgs.searchPlaceholder":
    "Procure organiza\u00e7\u00f5es por nome ou slug...",
  "admin.users.columnCreated": "Criado",
  "admin.users.columnEmail": "E-mail",
  "admin.users.columnUser": "Usu\u00e1rio",
  "admin.users.failedToImpersonate":
    "Falha ao assumir identidade do usu\u00e1rio",
  "admin.users.failedToLoadDescription":
    "Algo deu errado. Atualize a p\u00e1gina para tentar novamente.",
  "admin.users.failedToLoadTitle": "Falha ao carregar usu\u00e1rios",
  "admin.users.impersonate": "Assumir identidade",
  "admin.users.noUsersFoundTitle": "Nenhum usu\u00e1rio encontrado",
  "admin.users.noUsersMatchSearch":
    'Nenhum usu\u00e1rio corresponde a "{search}"',
  "admin.users.noUsersYet": "Nenhum usu\u00e1rio ainda.",
  "admin.users.searchPlaceholder":
    "Pesquise usu\u00e1rios por e-mail ou nome...",
  "admin.users.unknown": "Desconhecido",
  "admin.users.unverified": "N\u00e3o verificado",
  "admin.users.verified": "Verificado",
} satisfies Record<keyof typeof adminEn, string>;
