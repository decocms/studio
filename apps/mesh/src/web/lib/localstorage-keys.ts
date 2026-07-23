import type { ProjectLocator } from "@decocms/mesh-sdk";

/**
 * Known localStorage keys for the studio app.
 * When adding a new use of useLocalStorage, add the key to this object.
 * This is used to avoid inline key definitions and to ensure consistency.
 */
export const LOCALSTORAGE_KEYS = {
  chatSelectedImageModel: (locator: ProjectLocator) =>
    `mesh:chat:selectedImageModel:${locator}`,
  chatSelectedWebSearchModel: (locator: ProjectLocator) =>
    `mesh:chat:selectedWebSearchModel:${locator}`,
  chatSelectedDeepResearchModel: (locator: ProjectLocator) =>
    `mesh:chat:selectedDeepResearchModel:${locator}`,
  chatSimpleModeTier: (locator: ProjectLocator) =>
    `mesh:chat:simpleModeTier:${locator}`,
  chatLastAgentOption: (locator: ProjectLocator) =>
    `mesh:chat:lastAgentOption:${locator}`,
  chatAutosend: (locator: ProjectLocator | string, taskId: string) =>
    `mesh:chat:autosend:${locator}:${taskId}`,
  chatDraft: (locator: ProjectLocator | string, taskKey: string) =>
    `mesh:chat:draft:${locator}:${taskKey}`,
  sidePanelWidth: () => `mesh:side-panel:width`,
  sidebarOpen: () => `mesh:sidebar-open`,
  preferences: () => `mesh:user:preferences`,
  lastOrgSlug: () => `mesh:last-org-slug`,
  lastLocation: () => `mesh:last-location`,
  connectionsTab: (org: string) => `mesh:connections:tab:${org}`,
  taskLastViewed: (locator: ProjectLocator) =>
    `mesh:chat:task-last-viewed:${locator}`,
  sidebarGroupOrder: (orgId: string, userId: string) =>
    `sidebar.group-order.${orgId}.${userId}`,
  ptBrAnnouncementSeen: (userId: string) => `mesh:announcement:pt-br:${userId}`,
  cmsTourSeen: (userId: string) => `mesh:cms-tour:seen:${userId}`,
} as const;
