import type { header as headerEn } from "../en/header.ts";

export const header = {
  "header.linkedDesktopIndicator.availableCapabilities":
    "Disponível: {capabilities}",
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
    "Nenhuma organização disponível",
  "header.orgSwitcher.noOrganizationsMatch":
    'Nenhuma organização coincide com "{query}"',
  "header.orgSwitcher.searchOrganizations": "Pesquisar organizações...",
  "header.orgSwitcher.unknownOrganization": "Organização desconhecida",
} satisfies Record<keyof typeof headerEn, string>;
