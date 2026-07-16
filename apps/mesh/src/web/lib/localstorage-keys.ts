import type { ProjectLocator } from "@decocms/mesh-sdk";

/**
 * Known localStorage keys for the Studio app.
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
} as const;

/**
 * One-time migration of pre-rename localStorage keys ("mesh:*", plus the
 * "mesh-*" list-state keys) to their "studio:*" / "studio-*" names, so users
 * keep their persisted UI state across the rename. The new key wins when both
 * exist; the old key is removed either way. Runs at module init —
 * `src/web/index.tsx` imports this module first, before anything reads
 * localStorage.
 */
export function migrateLegacyLocalStorageKeys(
  storage: Pick<
    Storage,
    "length" | "key" | "getItem" | "setItem" | "removeItem"
  >,
): void {
  const legacy: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith("mesh:") || key?.startsWith("mesh-")) {
      legacy.push(key);
    }
  }
  for (const oldKey of legacy) {
    const newKey = `studio${oldKey.slice("mesh".length)}`;
    const value = storage.getItem(oldKey);
    if (value !== null && storage.getItem(newKey) === null) {
      storage.setItem(newKey, value);
    }
    storage.removeItem(oldKey);
  }
}

try {
  if (globalThis.localStorage) {
    migrateLegacyLocalStorageKeys(globalThis.localStorage);
  }
} catch {
  // No localStorage (tests/SSR) or quota error — never block boot over UI state.
}
