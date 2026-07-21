import type { header as headerEn } from "../en/header.ts";

export const header = {
  "header.linkedDesktopIndicator.availableCapabilities":
    "Dispon\u00edvel: {capabilities}",
  "header.linkedDesktopIndicator.connectDesktop": "Conectar desktop",
  "header.linkedDesktopIndicator.connectYourDesktop": "Conecte seu desktop",
  "header.linkedDesktopIndicator.desktopDisconnected": "Desktop desconectado",
  "header.linkedDesktopIndicator.desktopLinked": "Desktop vinculado",
  "header.linkedDesktopIndicator.noCliAgents": "Nenhum agente CLI detectado",
  "header.orgSwitcher.accept": "Aceitar",
  "header.orgSwitcher.declineInvitationTo": "Recusar convite para {name}",
  "header.orgSwitcher.failedToAcceptInvitation": "Falha ao aceitar convite",
  "header.orgSwitcher.failedToDeclineInvitation": "Falha ao recusar convite",
  "header.orgSwitcher.invitationDeclined": "Convite recusado",
  "header.orgSwitcher.invitedToJoin": "Convidado para entrar",
  "header.orgSwitcher.joined": "Entrou em {name}",
  "header.orgSwitcher.noOrganizationsAvailable":
    "Nenhuma organiza\u00e7\u00e3o dispon\u00edvel",
  "header.orgSwitcher.noOrganizationsMatch":
    'Nenhuma organiza\u00e7\u00e3o coincide com "{query}"',
  "header.orgSwitcher.searchOrganizations":
    "Pesquisar organiza\u00e7\u00f5es...",
  "header.orgSwitcher.unknownOrganization":
    "Organiza\u00e7\u00e3o desconhecida",
} satisfies Record<keyof typeof headerEn, string>;
