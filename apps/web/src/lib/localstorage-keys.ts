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
  chatThreadIntent: (locator: ProjectLocator | string, taskId: string) =>
    `studio:chat:threadIntent:${locator}:${taskId}`,
  homeTaskMode: (locator: ProjectLocator | string) =>
    `home-task-mode:${locator}`,
  chatDraft: (locator: ProjectLocator | string, taskKey: string) =>
    `studio:chat:draft:${locator}:${taskKey}`,
  /** One entry per locator holding that org's recently-viewed task PR cards. */
  taskBoardPrs: (locator: ProjectLocator) => `studio:task-board-prs:${locator}`,
  /** Whether the task feed shows agent-to-agent handoff and run posts. */
  taskFeedBehindTheScenes: () => `studio:task-feed:behind-the-scenes`,
  /** The assignee filter the org's task board opens on for this user. */
  taskBoardAssignee: (orgId: string, userId: string) =>
    `studio:task-board-assignee:${orgId}:${userId}`,
  /** One entry per org holding the apps last opened in it — see
   *  `lib/recent-apps.ts`. */
  recentApps: (orgSlug: string) => `studio:recent-apps:${orgSlug}`,
  /** Every app opened in the org, newest first, as `appOpenKey`s — the org
   *  home's tile order. Longer than `recentApps`, which is the rail's four. */
  appOpens: (orgSlug: string) => `studio:app-opens:${orgSlug}`,
  /** Not scoped to an org — this is the list of orgs themselves. */
  recentOrgs: () => `studio:recent-orgs`,
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
  blogBoardCollapsedLanes: () => `studio:blog-board:collapsed-lanes`,
  /** Per-project "Local" preview override — a tunnel URL the CMS + preview point
   *  at instead of the managed sandbox/production. Per-browser: a tunnel to a
   *  dev server only this machine can reach, so it never belongs on shared
   *  project metadata. */
  localPreviewUrl: (virtualMcpId: string) =>
    `studio:local-preview-url:${virtualMcpId}`,
} as const;
