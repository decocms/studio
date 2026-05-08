/**
 * Pure helpers for the `?main=<tabId>|0` URL model.
 *
 * Tab id grammar:
 *   - Fixed system: "settings" | "automations" | "env" | "preview" | "git"
 *   - Legacy fixed system (redirected to "settings"): "instructions" | "connections" | "layout"
 *   - Agent-declared: <agentTab.id> (from virtualMcp.metadata.ui.layout.tabs)
 *   - Expanded-from-chat: <toolName> (from task.metadata.expanded_tools)
 *   - Pinned view: "app:<connectionId>:<toolName>" (from metadata.ui.pinnedViews)
 *   - Ephemeral automation: "automation:<id>"
 *   - "0" = closed sentinel (not an actual tab id)
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
 * same name without colliding in the `?main=` URL state.
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

export const FIXED_SYSTEM_TABS = [
  "settings",
  "automations",
  "env",
  "preview",
  "git",
] as const;

const FIXED_SYSTEM_TAB_SET = new Set<string>(FIXED_SYSTEM_TABS);

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

export function resolveActiveTabAndOpen(ctx: {
  mainParam: string | undefined;
  metadata: EntityLayoutMetadata | null;
}): { mainOpen: boolean; activeTab: string } {
  const def = resolveDefaultTabId(ctx.metadata);

  if (ctx.mainParam === "0") {
    return { mainOpen: false, activeTab: def };
  }
  if (ctx.mainParam === undefined) {
    // Mirror resolveDefaultPanelState: a chat-default (or absent default)
    // keeps the main panel closed so the header tab bar doesn't highlight
    // a tab while the panel is 0px wide.
    const view = ctx.metadata?.defaultMainView ?? null;
    const defaultIsChat = view == null || view.type === "chat";
    return { mainOpen: !defaultIsChat, activeTab: def };
  }
  // Legacy ids coming from URL state migrate to the unified settings tab.
  if (LEGACY_SETTINGS_TABS.has(ctx.mainParam)) {
    return { mainOpen: true, activeTab: "settings" };
  }
  return { mainOpen: true, activeTab: ctx.mainParam };
}

/**
 * Tab-as-toggle semantics for the header tab bar.
 *
 * Clicking the currently-active tab while the panel is open closes it
 * (navigates to `?main=0`). Any other click opens or switches.
 */
export function resolveTabClickTarget(ctx: {
  clickedId: string;
  activeTab: string;
  mainOpen: boolean;
}): string {
  if (ctx.mainOpen && ctx.clickedId === ctx.activeTab) return "0";
  return ctx.clickedId;
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
 * - On the list with the panel open → close (`"0"`).
 * - On a detail view → navigate up to the list (`"automations"`).
 * - Otherwise (panel closed or on a different tab) → open the list.
 */
export function resolveAutomationsPillClickTarget(ctx: {
  activeTab: string;
  mainOpen: boolean;
}): string {
  if (ctx.mainOpen && ctx.activeTab === "automations") return "0";
  return "automations";
}
