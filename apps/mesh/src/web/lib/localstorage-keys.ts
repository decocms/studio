import type { ProjectLocator } from "@decocms/mesh-sdk";

/**
 * Known localStorage keys for the mesh app.
 * When adding a new use of useLocalStorage, add the key to this object.
 * This is used to avoid inline key definitions and to ensure consistency.
 */
export const LOCALSTORAGE_KEYS = {
  assistantChatTasks: (locator: ProjectLocator) =>
    `mesh:assistant-chat:tasks:${locator}`,
  messages: (locator: ProjectLocator, taskId: string) =>
    `mesh:messages:${locator}:${taskId}`,
  chatSelectedModel: (locator: ProjectLocator) =>
    `mesh:chat:selectedModel:${locator}`,
  chatSelectedMode: (locator: ProjectLocator) =>
    `mesh:chat:selectedMode:${locator}`,
  chatSelectedKeyId: (locator: ProjectLocator) =>
    `mesh:chat:selectedKeyId:${locator}`,
  chatSelectedImageModel: (locator: ProjectLocator) =>
    `mesh:chat:selectedImageModel:${locator}`,
  assistantChatActiveTask: (locator: ProjectLocator) =>
    `mesh:assistant-chat:active-task:${locator}`,
  decoChatPanelWidth: () => `mesh:decochat:panel-width`,
  decoTasksPanelWidth: () => `mesh:decotasks:panel-width`,
  sidebarOpen: () => `mesh:sidebar-open`,
  orgHomeQuickstart: (org: string) => `mesh:org-home:quickstart:${org}`,
  storeShowStdio: () => `mesh:store:show-stdio`,
  preferences: () => `mesh:user:preferences`,
  pluginConnection: (org: string, pluginId: string) =>
    `mesh:plugin:connection:${org}:${pluginId}`,
  chatTaskOwnerFilter: (locator: ProjectLocator) =>
    `mesh:chat:task-owner-filter:${locator}`,
  lastOrgSlug: () => `mesh:last-org-slug`,
  connectionsTab: (org: string) => `mesh:connections:tab:${org}`,
  taskLastViewed: (locator: ProjectLocator) =>
    `mesh:chat:task-last-viewed:${locator}`,
  agentLastSeen: (orgId: string) => `mesh:agent:last-seen:${orgId}`,
  agentLastUpdated: (orgId: string) => `mesh:agent:last-updated:${orgId}`,
} as const;
