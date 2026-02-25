import type { ProjectLocator } from "@decocms/mesh-sdk";

/**
 * Known localStorage keys for the mesh app.
 * When adding a new use of useLocalStorage, add the key to this object.
 * This is used to avoid inline key definitions and to ensure consistency.
 */
export const LOCALSTORAGE_KEYS = {
  assistantChatThreads: (locator: ProjectLocator) =>
    `mesh:assistant-chat:threads:${locator}`,
  messages: (locator: ProjectLocator, threadId: string) =>
    `mesh:messages:${locator}:${threadId}`,
  decoChatOpen: () => `mesh:decochat:open`,
  chatSelectedModel: (locator: ProjectLocator) =>
    `mesh:chat:selectedModel:${locator}`,
  chatSelectedMode: (locator: ProjectLocator) =>
    `mesh:chat:selectedMode:${locator}`,
  assistantChatActiveThread: (locator: ProjectLocator) =>
    `mesh:assistant-chat:active-thread:${locator}`,
  decoChatPanelWidth: () => `mesh:decochat:panel-width`,
  sidebarOpen: () => `mesh:sidebar-open`,
  selectedRegistry: (org: string) => `mesh:store:selected-registry:${org}`,
  orgHomeQuickstart: (org: string) => `mesh:org-home:quickstart:${org}`,
  gitPanelOpen: () => `mesh:git-panel:open`,
  storeShowStdio: () => `mesh:store:show-stdio`,
  preferences: () => `mesh:user:preferences`,
  pluginConnection: (org: string, pluginId: string) =>
    `mesh:plugin:connection:${org}:${pluginId}`,
} as const;
