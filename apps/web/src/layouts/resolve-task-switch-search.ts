/**
 * Pure computation of the `?main`/`?sidepanel`/`?virtualmcpid` search params
 * produced when switching to another thread. Extracted from `usePanelActions`
 * (shell-layout) so the precedence rules are unit-testable without a router.
 *
 * Precedence for the main tab:
 *   1. `opts.main` — an explicit caller intent (e.g. home tile → pinned view).
 *   2. `savedLayout` — the target thread's own remembered layout (per-thread
 *      memory). Restores that thread's tabs, including per-thread views it owned.
 *   3. carry-forward — within the same agent, keep a system-level tab
 *      (git/preview/settings/…) but drop per-thread tabs from the source thread.
 *      Skipped on an agent switch so the new agent's own default resolves.
 *
 * The side panel defaults to chat-open unless the restored layout closed it.
 */

import { isPerThreadTab } from "@/layouts/main-panel-tabs/tab-id";
import type { ThreadLayout } from "@/lib/thread-layout-memory";

export interface ResolveTaskSwitchInput {
  /** The current (source) thread's search params. */
  prev: { virtualmcpid?: unknown; main?: unknown };
  /** Target agent id, when the caller pins one. */
  virtualMcpId?: string;
  /** Well-known Decopilot agent id — the default when no `virtualmcpid`. */
  decopilotId: string;
  /** The target thread's remembered layout, or null if none. */
  savedLayout: ThreadLayout | null;
  opts?: { autosend?: boolean; main?: string };
  /** `?autosend` sentinel value, injected to avoid an import cycle. */
  autosendValue: string;
}

export function resolveTaskSwitchSearch(
  input: ResolveTaskSwitchInput,
): Record<string, unknown> {
  const { prev, virtualMcpId, decopilotId, savedLayout, opts, autosendValue } =
    input;

  const next: Record<string, unknown> = {};
  if (virtualMcpId) next.virtualmcpid = virtualMcpId;
  else if (prev.virtualmcpid) next.virtualmcpid = prev.virtualmcpid;

  // The Super Agent (Decopilot) is the default when the URL carries no
  // `virtualmcpid`, so treat an absent id as Decopilot on BOTH sides —
  // otherwise switching FROM the param-less Super Agent TO a repo agent isn't
  // detected as a switch and wrongly carries the previous view forward.
  const prevVmcp =
    typeof prev.virtualmcpid === "string" ? prev.virtualmcpid : decopilotId;
  const targetVmcp = virtualMcpId ?? prevVmcp;
  const isAgentSwitch = targetVmcp !== prevVmcp;

  let sidepanel: "chat" | 0 = "chat";

  if (opts?.main) {
    // Explicit intent wins outright — ignore saved/carried layout.
    next.main = opts.main;
  } else if (savedLayout) {
    // Restore the target thread's own layout. A remembered per-thread tab is
    // valid here because it belongs to *this* thread; if it has since become
    // stale, MainPanelContent falls back to Settings rather than crashing.
    if (savedLayout.main !== undefined) next.main = savedLayout.main;
    if (savedLayout.sidepanel !== undefined) sidepanel = savedLayout.sidepanel;
  } else if (!isAgentSwitch) {
    const prevMain = prev.main;
    if (prevMain && typeof prevMain === "string" && !isPerThreadTab(prevMain)) {
      next.main = prevMain;
    }
  }

  next.sidepanel = sidepanel;
  if (opts?.autosend) next.autosend = autosendValue;
  return next;
}
