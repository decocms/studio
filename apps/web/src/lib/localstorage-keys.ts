import type { ProjectLocator } from "@/sdk";

/**
 * Known localStorage keys for the studio app.
 * When adding a new use of useLocalStorage, add the key to this object.
 * This is used to avoid inline key definitions and to ensure consistency.
 */
export const LOCALSTORAGE_KEYS = {
  chatSelectedImageModel: (locator: ProjectLocator) =>
    `studio:chat:selectedImageModel:${locator}`,
  chatSelectedWebSearchModel: (locator: ProjectLocator) =>
    `studio:chat:selectedWebSearchModel:${locator}`,
  chatSelectedDeepResearchModel: (locator: ProjectLocator) =>
    `studio:chat:selectedDeepResearchModel:${locator}`,
  chatSimpleModeTier: (locator: ProjectLocator) =>
    `studio:chat:simpleModeTier:${locator}`,
  chatLastAgentOption: (locator: ProjectLocator) =>
    `studio:chat:lastAgentOption:${locator}`,
  chatAutosend: (locator: ProjectLocator | string, taskId: string) =>
    `studio:chat:autosend:${locator}:${taskId}`,
  chatDraft: (locator: ProjectLocator | string, taskKey: string) =>
    `studio:chat:draft:${locator}:${taskKey}`,
  sidePanelWidth: () => `studio:side-panel:width`,
  sidebarOpen: () => `studio:sidebar-open`,
  preferences: () => `studio:user:preferences`,
  lastOrgSlug: () => `studio:last-org-slug`,
  lastLocation: () => `studio:last-location`,
  connectionsTab: (org: string) => `studio:connections:tab:${org}`,
  taskLastViewed: (locator: ProjectLocator) =>
    `studio:chat:task-last-viewed:${locator}`,
  sidebarGroupOrder: (orgId: string, userId: string) =>
    `sidebar.group-order.${orgId}.${userId}`,
  ptBrAnnouncementSeen: (userId: string) =>
    `studio:announcement:pt-br:${userId}`,
  cmsTourSeen: (userId: string) => `studio:cms-tour:seen:${userId}`,
} as const;
