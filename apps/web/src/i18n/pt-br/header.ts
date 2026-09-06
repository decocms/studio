import type { header as headerEn } from "../en/header.ts";

export const header = {
  "header.orgSwitcher.accept": "Aceitar",
  "header.orgSwitcher.declineInvitationTo": "Recusar convite para {name}",
  "header.orgSwitcher.failedToAcceptInvitation": "Falha ao aceitar convite",
  "header.orgSwitcher.failedToDeclineInvitation": "Falha ao recusar convite",
  "header.orgSwitcher.invitationDeclined": "Convite recusado",
  "header.orgSwitcher.invitedToJoin": "Convidado para entrar",
  "header.orgSwitcher.joined": "Entrou em {name}",
  "header.orgSwitcher.unknownOrganization": "Organização desconhecida",
} satisfies Record<keyof typeof headerEn, string>;
