/**
 * Pure helpers for the tab id — the app's ONE name for a main-panel view.
 *
 * Tab id grammar:
 *   - Fixed system: "settings" | "automations" | "preview" | "git"
 *   - Legacy fixed system (redirected to "settings"): "instructions" | "connections" | "layout"
 *   - Agent-declared: <agentTab.id> (from virtualMcp.metadata.ui.layout.tabs)
 *   - Expanded-from-chat: <toolName> (from task.metadata.expanded_tools)
 *   - Pinned view: "app:<connectionId>:<toolName>" (from metadata.ui.pinnedViews)
 *   - Ephemeral automation: "automation:<id>"
 *   - Ephemeral file preview: "file:<encoded output key>" (thread output viewer)
 *   - Ephemeral deck preview: "deck:<encoded home-volume path>" (slides skill)
 *   - Ephemeral Library file preview: "library-file:<encoded browse path>"
 *
 * A tab id is internal: the tab bar, the per-thread layout memory and the bar's
 * order storage speak it, and `panel-route.ts` is the single boundary that
 * writes it into the URL as `/agents/{-$project}/{-$panel}` and reads it back.
 * There is no closed sentinel any more — whether the panel is open is
 * `?mainpanel`, a separate boolean, so a closed panel still remembers its view.
 *
 * The "settings" tab bundles what used to be separate instructions,
 * connections, and layout tabs. GitHub-linked Virtual MCPs expose an
 * additional "git" tab (branch/PR panel) alongside settings.
 */

export interface EntityLayoutMetadata {
  defaultMainView?: {
    type: string;
    id?: string;
    toolName?: string;
  } | null;
  tabs?: Array<{ id: string }>;
}

export interface AutomationTabParsed {
  id: string;
}

export function parseAutomationTabId(
  tabId: string | undefined,
): AutomationTabParsed | null {
  if (!tabId || !tabId.startsWith("automation:")) return null;
  const id = tabId.slice("automation:".length);
  if (!id) return null;
  return { id };
}

export interface PinnedViewTabParsed {
  connectionId: string;
  toolName: string;
}

/**
 * Format a pinned view's composite tab id. Carries both `connectionId`
 * and `toolName` so two different connections can expose tools with the
 * same name without colliding in the tab-id grammar.
 */
export function formatPinnedViewTabId(
  connectionId: string,
  toolName: string,
): string {
  return `app:${connectionId}:${toolName}`;
}

export function parsePinnedViewTabId(
  tabId: string | undefined,
): PinnedViewTabParsed | null {
  if (!tabId || !tabId.startsWith("app:")) return null;
  const rest = tabId.slice("app:".length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const connectionId = rest.slice(0, sep);
  const toolName = rest.slice(sep + 1);
  if (!connectionId || !toolName) return null;
  return { connectionId, toolName };
}

export interface DeckTabParsed {
  /** Home-volume-relative deck path, e.g. `decks/q3-launch.html`. */
  path: string;
}

/** Paths carry `/`, so the tab id encodes them to keep the
 *  `<kind>:<rest>` tab-id grammar unambiguous. */
export function formatDeckTabId(path: string): string {
  return `deck:${encodeURIComponent(path)}`;
}

export function parseDeckTabId(
  tabId: string | undefined,
): DeckTabParsed | null {
  if (!tabId || !tabId.startsWith("deck:")) return null;
  const encoded = tabId.slice("deck:".length);
  if (!encoded) return null;
  try {
    return { path: decodeURIComponent(encoded) };
  } catch {
    return null;
  }
}

export interface FileTabParsed {
  /** Thread-output key: an org-fs ref
   *  (`org-fs:outputs/<threadId>/x.pdf`) — the same shape returned by the
   *  thread-outputs endpoint. */
  key: string;
}

/** Keys carry `/` and `:`, so the tab id encodes them to keep the
 *  `<kind>:<rest>` tab-id grammar unambiguous. */
export function formatFileTabId(key: string): string {
  return `file:${encodeURIComponent(key)}`;
}

export function parseFileTabId(
  tabId: string | undefined,
): FileTabParsed | null {
  if (!tabId || !tabId.startsWith("file:")) return null;
  const encoded = tabId.slice("file:".length);
  if (!encoded) return null;
  try {
    return { key: decodeURIComponent(encoded) };
  } catch {
    return null;
  }
}

export interface LibraryFileTabParsed {
  /** Library browse path, e.g. `home/docs/a.md` or `public/core/a.ts`. */
  path: string;
}

/** Browse paths carry `/`, so the tab id encodes them to keep the
 *  `<kind>:<rest>` tab-id grammar unambiguous. */
export function formatLibraryFileTabId(path: string): string {
  return `library-file:${encodeURIComponent(path)}`;
}

export function parseLibraryFileTabId(
  tabId: string | undefined,
): LibraryFileTabParsed | null {
  if (!tabId || !tabId.startsWith("library-file:")) return null;
  const encoded = tabId.slice("library-file:".length);
  if (!encoded) return null;
  try {
    return { path: decodeURIComponent(encoded) };
  } catch {
    return null;
  }
}

export interface CodeTabParsed {
  /** File to open in the code tab, or null for the bare file-tree view. */
  path: string | null;
}

/** Paths carry `/`, so the tab id encodes them to keep the
 *  `<kind>:<rest>` tab-id grammar unambiguous. */
export function formatCodeTabId(path: string): string {
  return `code:${encodeURIComponent(path)}`;
}

export function parseCodeTabId(
  tabId: string | undefined,
): CodeTabParsed | null {
  if (!tabId) return null;
  if (tabId === "code") return { path: null };
  if (!tabId.startsWith("code:")) return null;
  const encoded = tabId.slice("code:".length);
  if (!encoded) return null;
  try {
    return { path: decodeURIComponent(encoded) };
  } catch {
    return null;
  }
}

export const FIXED_SYSTEM_TABS = [
  "overview",
  "settings",
  "automations",
  "preview",
  "code",
  "content",
  "assets",
  "hosting",
  "e2e",
  "analytics",
  "cdn",
  "git",
] as const;

const FIXED_SYSTEM_TAB_SET = new Set<string>(FIXED_SYSTEM_TABS);

// Agent-independent overlays (Tasks `board`, Library `files`, the commerce
// report's `connect-sources`, the empty `reports`) take over the panel and aren't
// sandbox-backed views. Shared by the drawer-visibility check and the
// in-panel-app navigate allowlist so the two stay in sync.
export const OVERLAY_TABS = new Set([
  "board",
  "files",
  "connect-sources",
  "reports",
]);

/**
 * Returns true for tab ids that are scoped to a specific thread and must not
 * be carried across task switches:
 *   - "app:<connectionId>:<toolName>"  (expanded tool / pinned view)
 *   - "automation:<id>"               (ephemeral automation detail)
 *   - "file:<encoded key>"            (ephemeral thread-output file preview)
 *   - "deck:<encoded path>"           (ephemeral HTML-artifact preview/editor)
 *   - "library-file:<encoded path>"   (ephemeral org Library file preview)
 *   - "code:<encoded path>"           (open file in the Code tab's file explorer,
 *     scoped to the task's branch/sandbox — the bare "code" tab id is NOT
 *     per-thread, only a specific open path is)
 */
export function isPerThreadTab(tabId: string): boolean {
  return (
    tabId.startsWith("app:") ||
    tabId.startsWith("automation:") ||
    tabId.startsWith("file:") ||
    tabId.startsWith("deck:") ||
    tabId.startsWith("library-file:") ||
    tabId.startsWith("code:")
  );
}

/**
 * Legacy tab ids that were merged into the unified "settings" tab. Kept
 * here so saved defaults / URL state migrate cleanly.
 */
const LEGACY_SETTINGS_TABS = new Set<string>([
  "instructions",
  "connections",
  "layout",
  "settings",
]);

export function isLegacySettingsTab(tabId: string | undefined): boolean {
  return !!tabId && LEGACY_SETTINGS_TABS.has(tabId);
}

export function resolveDefaultTabId(
  metadata: EntityLayoutMetadata | null,
): string {
  const def = metadata?.defaultMainView ?? null;
  if (!def) return "settings";

  // Legacy tab ids (instructions/connections/layout) now live inside the
  // unified "settings" tab.
  if (LEGACY_SETTINGS_TABS.has(def.type)) return "settings";

  // Direct mapping for any fixed system tab id.
  if (FIXED_SYSTEM_TAB_SET.has(def.type)) return def.type;

  if (def.type === "ext-app" || def.type === "ext-apps") {
    // Pinned view default: { type: "ext-apps", id: connectionId, toolName }.
    // Round-trip as the composite pinned-view tab id so the pinned-view
    // branch in MainPanelContent renders it without a metadata round-trip.
    if (def.id && def.toolName) {
      return formatPinnedViewTabId(def.id, def.toolName);
    }
    const declaredTabIds = metadata?.tabs?.map((t) => t.id) ?? [];
    if (def.id && declaredTabIds.includes(def.id)) return def.id;
    return declaredTabIds[0] ?? "settings";
  }

  return metadata?.tabs?.[0]?.id ?? "settings";
}

/**
 * The view showing in the main panel, and whether the panel is open — the two
 * things `?main=` used to conflate, resolved from the two things that replaced
 * it: the `{-$panel}` path segment and the `?mainpanel` boolean.
 *
 * Precedence for the view: the segment, then the destination route's own
 * default (`board` on `/$org/tasks`), then the agent's `defaultMainView`.
 * The panel is open when the URL says so, and by default whenever a view is
 * named — by the path, by the route, or by an agent whose default is not chat.
 */
export function resolveActiveTabAndOpen(ctx: {
  /** The `{-$panel}` segment's tab id; `undefined` when it names no view. */
  panelTabId: string | undefined;
  /** `?mainpanel`, when the URL carries one. */
  mainPanelParam?: boolean;
  metadata: EntityLayoutMetadata | null;
  /** The destination route's default view (e.g. `board` on `/$org/tasks`).
   *  Wins over the agent's `defaultMainView`, loses to the path segment. */
  routeDefaultMain?: string | null;
}): { mainOpen: boolean; activeTab: string } {
  const def = ctx.routeDefaultMain || resolveDefaultTabId(ctx.metadata);
  // Legacy ids coming from URL state migrate to the unified settings tab.
  const named =
    ctx.panelTabId && LEGACY_SETTINGS_TABS.has(ctx.panelTabId)
      ? "settings"
      : ctx.panelTabId;

  const view = ctx.metadata?.defaultMainView ?? null;
  const defaultIsChat = view == null || view.type === "chat";
  const mainOpen =
    ctx.mainPanelParam ?? (!!named || !!ctx.routeDefaultMain || !defaultIsChat);

  return { mainOpen, activeTab: named ?? def };
}

/** Where a tab click lands: another view, or the panel closed. */
export type TabClickTarget = { close: true } | { tabId: string };

/**
 * Tab-as-toggle semantics for the header tab bar.
 *
 * Clicking the currently-active tab while the panel is open closes it — which
 * now leaves the view in the path, so re-opening returns to it. Any other click
 * opens or switches.
 */
export function resolveTabClickTarget(ctx: {
  clickedId: string;
  activeTab: string;
  mainOpen: boolean;
}): TabClickTarget {
  if (ctx.mainOpen && ctx.clickedId === ctx.activeTab) return { close: true };
  return { tabId: ctx.clickedId };
}

/**
 * The "Automations" header pill is active whenever the main panel is open
 * and the active tab is either the list (`automations`) or a detail
 * (`automation:<id>` / `automation:new`).
 */
export function isAutomationsPillActive(ctx: {
  activeTab: string;
  mainOpen: boolean;
}): boolean {
  if (!ctx.mainOpen) return false;
  if (ctx.activeTab === "automations") return true;
  return parseAutomationTabId(ctx.activeTab) !== null;
}

/**
 * Click target for the Automations pill.
 *
 * - On the list with the panel open → close.
 * - On a detail view → navigate up to the list (`"automations"`).
 * - Otherwise (panel closed or on a different tab) → open the list.
 */
export function resolveAutomationsPillClickTarget(ctx: {
  activeTab: string;
  mainOpen: boolean;
}): TabClickTarget {
  if (ctx.mainOpen && ctx.activeTab === "automations") return { close: true };
  return { tabId: "automations" };
}
