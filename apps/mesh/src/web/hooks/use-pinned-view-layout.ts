import { useVirtualMCP } from "@decocms/mesh-sdk";
import { useMatch } from "@tanstack/react-router";

/**
 * Determines the initial collapsed state for main and chat panels on the agent
 * home route.
 *
 * Rules:
 * - Non-agent-home routes: both panels start expanded.
 * - `?main` param present: both panels start expanded.
 * - Agent home, no `?main`:
 *   - defaultMainView is chat/null → chat expanded, main collapsed.
 *   - defaultMainView is non-chat  → main expanded, chat uses
 *     `layout.chatDefaultOpen` (defaults to false).
 */
export function usePinnedViewLayout(
  virtualMcpId: string | undefined,
  isAgentRoute: boolean,
): { chatDefaultCollapsed: boolean; mainDefaultCollapsed: boolean } {
  const entity = useVirtualMCP(virtualMcpId);

  const agentHomeMatch = useMatch({
    from: "/shell/$org/$virtualMcpId/",
    shouldThrow: false,
  });

  const isOnAgentHome = isAgentRoute && !!agentHomeMatch;
  if (!isOnAgentHome) {
    return { chatDefaultCollapsed: false, mainDefaultCollapsed: false };
  }

  const hasMainParam = !!agentHomeMatch?.search.main;
  if (hasMainParam) {
    return { chatDefaultCollapsed: false, mainDefaultCollapsed: false };
  }

  const layoutConfig = (
    entity?.metadata?.ui as Record<string, unknown> | null | undefined
  )?.layout as {
    defaultMainView?: { type: string };
    chatDefaultOpen?: boolean | null;
  } | null;

  const defaultViewType = layoutConfig?.defaultMainView?.type ?? null;
  const showMain =
    defaultViewType === "automation" ||
    defaultViewType === "ext-apps" ||
    defaultViewType === "settings";

  if (!showMain) {
    // Default view is chat or unset — chat must be visible, main collapsed
    return { chatDefaultCollapsed: false, mainDefaultCollapsed: true };
  }

  // Non-chat default view — respect chatDefaultOpen config (defaults to false)
  const chatDefaultOpen = layoutConfig?.chatDefaultOpen ?? false;

  return {
    chatDefaultCollapsed: !chatDefaultOpen,
    mainDefaultCollapsed: false,
  };
}
