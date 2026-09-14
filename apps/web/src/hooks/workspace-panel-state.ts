/** Pure panel visibility, layout actions, and workspace identity. */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntityLayoutMetadata {
  defaultMainView?: {
    type: string;
    id?: string;
    toolName?: string;
  } | null;
  /** Open Chat in the side panel alongside a non-chat default main view. */
  chatDefaultOpen?: boolean | null;
  tabs?: Array<{ id: string }>;
}

export interface WorkspaceLayoutState {
  /** The open thread, or `null` on a destination route that names none. */
  threadId: string | null;
  /** React `key` for the workspace providers — identity, never a thread id. */
  providerKey: string;
  sidePanelOpen: boolean;
  mainOpen: boolean;
  /** Whether ?sidepanel was in the URL (vs. the agent-configured default). */
  sidePanelParamPresent: boolean;
}

export interface WorkspaceLayoutActions {
  toggleMain: () => void;
  toggleSidePanel: () => void;
  createNewTask: () => void;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

export interface WorkspaceVisibility {
  sidePanelOpen: boolean;
  mainOpen: boolean;
}

export type WorkspacePanelAction =
  | { type: "toggleSidePanel" }
  | { type: "toggleMain" }
  | { type: "openSidePanel" };

export type WorkspacePanelSearchUpdate = {
  sidepanel?: boolean;
  mainpanel?: boolean;
};

/** {@link WorkspaceLayoutState}'s thread fields, split so neither can stand in
 *  for the other. */
export interface WorkspaceThread {
  threadId: string | null;
  providerKey: string;
}

/**
 * Pure core of the workspace's thread identity.
 *
 * A destination route names no thread until one is opened, but the providers
 * below it still need a stable React `key` so a later switch remounts them.
 * Those are two different values: `providerKey` falls back to a client-side id
 * so the tree keeps its identity, while `threadId` stays `null` so nothing can
 * stream, fetch or report against a thread that does not exist.
 */
export function resolveWorkspaceThread(input: {
  routeThreadId: string | null;
  /** Client-side id, stable for the life of the mount. Never a thread. */
  fallbackKey: string;
}): WorkspaceThread {
  return {
    threadId: input.routeThreadId,
    providerKey: input.routeThreadId ?? input.fallbackKey,
  };
}

function withWorkspaceFallback(
  visibility: WorkspaceVisibility,
): WorkspaceVisibility {
  if (visibility.sidePanelOpen || visibility.mainOpen) return visibility;
  return { ...visibility, sidePanelOpen: true };
}

export function resolveDefaultPanelState(ctx: {
  entityMetadata: EntityLayoutMetadata | null;
  /** `?mainpanel`, when the URL carries one. */
  mainPanelParam?: boolean;
  /** Whether the deepest matched route names a concrete main view. */
  routeNamesView: boolean;
  sidePanelParamPresent: boolean;
  sidePanelParamValue?: boolean;
  /** The destination route's default view (e.g. `board` on `/$org/tasks`).
   *  Wins over the agent's `defaultMainView`. */
  routeDefaultMain?: string | null;
  /** The current thread already holds a conversation. Forces the chat panel
   *  open even when the agent opts out of it (`chatDefaultOpen: false`), so
   *  returning to a chat you've been talking in never drops you on a closed
   *  panel. An empty composer (no thread / empty thread) leaves this false. */
  threadHasMessages?: boolean;
}): WorkspaceVisibility {
  const defaultView = ctx.entityMetadata?.defaultMainView ?? null;
  const defaultIsChat = defaultView == null || defaultView.type === "chat";

  // The panel opens for any view the URL names — by path, by route, by agent.
  const mainOpen =
    ctx.mainPanelParam ??
    (ctx.routeNamesView || !!ctx.routeDefaultMain || !defaultIsChat);
  /**
   * A destination route that names its own main view IS that view's page —
   * going to Tasks without a conversation shows Tasks alone. A populated
   * thread takes precedence so following a chat back to any route never hides
   * that conversation. An explicit `sidepanel` still wins below.
   */
  const defaultSidePanelOpen = ctx.threadHasMessages
    ? true
    : ctx.routeDefaultMain
      ? false
      : defaultIsChat || ctx.entityMetadata?.chatDefaultOpen === true;
  const sidePanelOpen = ctx.sidePanelParamPresent
    ? ctx.sidePanelParamValue === true
    : defaultSidePanelOpen;

  return withWorkspaceFallback({ sidePanelOpen, mainOpen });
}

export function resolveWorkspacePanelAction(
  action: WorkspacePanelAction,
  visibility: WorkspaceVisibility,
): WorkspacePanelSearchUpdate | null {
  switch (action.type) {
    case "toggleSidePanel":
      if (visibility.sidePanelOpen) {
        return visibility.mainOpen
          ? { sidepanel: false }
          : { sidepanel: false, mainpanel: true };
      }
      return { sidepanel: true };
    case "toggleMain":
      return visibility.mainOpen
        ? { mainpanel: false, sidepanel: true }
        : { mainpanel: true };
    case "openSidePanel":
      return visibility.sidePanelOpen ? null : { sidepanel: true };
  }
}

export interface WorkspacePanelSizes {
  side: number;
  main: number;
}

export function computeWorkspacePanelSizes(
  visibility: WorkspaceVisibility,
): WorkspacePanelSizes {
  if (visibility.sidePanelOpen && visibility.mainOpen) {
    return { side: 33, main: 67 };
  }
  if (visibility.sidePanelOpen) return { side: 100, main: 0 };
  if (visibility.mainOpen) return { side: 0, main: 100 };
  return { side: 0, main: 0 };
}

export type MobileWorkspaceSurface = "chat" | "main";

/**
 * Mobile shows ONE surface at a time, so `?sidepanel` and `?mainpanel` can't
 * both win. An explicit `?sidepanel=true` does: it only ever gets written by an
 * intentional "open the chat" action (openSidePanel, the mobile view select),
 * and before this it was a silent no-op whenever the main panel happened to be
 * open — tapping Chat left you on the Preview view, booting a sandbox.
 * With no `?sidepanel` in the URL the panel state is the agent-configured
 * default, and there the main view keeps precedence.
 */
export function resolveMobileSurface(ctx: {
  visibility: WorkspaceVisibility;
  sidePanelParamPresent: boolean;
}): MobileWorkspaceSurface {
  const { sidePanelOpen, mainOpen } = ctx.visibility;
  if (sidePanelOpen && (ctx.sidePanelParamPresent || !mainOpen)) return "chat";
  return mainOpen ? "main" : "chat";
}

export function mobileSurfaceSearch(
  surface: MobileWorkspaceSurface,
): Required<WorkspacePanelSearchUpdate> {
  if (surface === "main") return { sidepanel: false, mainpanel: true };
  return { sidepanel: true, mainpanel: false };
}
