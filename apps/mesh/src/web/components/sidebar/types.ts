import type { ReactNode } from "react";

export interface NavigationSidebarItem {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  isActive?: boolean;
  /** Shows an external-link icon on hover and underlines the label */
  isExternal?: boolean;
}

export interface SidebarItemGroup {
  id: string;
  label: string;
  items: NavigationSidebarItem[];
  defaultExpanded?: boolean;
}

export type SidebarSection =
  | { type: "items"; items: NavigationSidebarItem[] }
  | { type: "group"; group: SidebarItemGroup }
  | { type: "divider" }
  | { type: "spacer" };

export interface Invitation {
  id: string;
  organizationId: string;
  organizationName?: string;
  organizationSlug?: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date;
  inviterId: string;
  inviter?: {
    name?: string;
    email?: string;
    image?: string;
  };
}
