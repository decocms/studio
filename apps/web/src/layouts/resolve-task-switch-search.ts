/**
 * Pure computation of what a thread switch lands on: a route-owned view (in
 * the tab-id vocabulary) and the shared panel search that goes with it. Extracted
 * from `usePanelActions` (shell-layout) so the precedence rules are
 * unit-testable without a router.
 *
 * Precedence for the view:
 *   1. `opts.view` — an explicit caller intent (e.g. home tile → pinned view).
 *   2. `savedLayout` — the target thread's own remembered layout (per-thread
 *      memory). Restores that thread's tabs, including per-thread views it owned.
 *   3. carry-forward — within the same agent, keep a system-level tab
 *      (git/preview/settings/…) but drop per-thread tabs from the source thread.
 *      Skipped on an agent switch so the new agent's own default resolves.
 *
 * The side panel is only pinned in the URL when the target thread's own
 * remembered layout recorded one. Otherwise `sidepanel` is omitted so
 * resolveDefaultPanelState derives the default from the target agent's layout
 * config (chatDefaultOpen / defaultMainView) — a fresh thread on an agent that
 * opts out of the chat panel must not be forced chat-open.
 *
 * PUSH vs REPLACE — the rule for every navigation in the workspace, stated once
 * here because this module is where a thread switch's URL is decided:
 *
 *   PUSH when the person chose to go somewhere. Opening a destination from the
 *   sidebar, picking a project from a sidebar agent row, switching to another
 *   thread: each is a place they can reasonably expect Back to return from.
 *
 *   REPLACE when the URL is only catching up with where they already are.
 *   Canonicalization (the `/$org` resolver, the legacy `/$org/$taskId`
 *   translation) and layout writes (`main`, `sidepanel`, board filters, the
 *   panel toggles) replace — a Back button that walks a person backwards
 *   through their own panel toggles or keystrokes is a broken Back button.
 */

import { isPerThreadTab } from "@/layouts/main-panel-tabs/tab-id";
import type { ThreadLayout } from "@/lib/thread-layout-memory";

export interface ResolveTaskSwitchInput {
  /** The current (source) thread's agent and open view. */
  prev: { agentId?: string; tabId?: string };
  /** Target agent id, when the caller pins one. */
  targetAgentId?: string;
  /** Well-known Decopilot agent id — the default when no agent is named. */
  decopilotId: string;
  /** The target thread's remembered layout, or null if none. */
  savedLayout: ThreadLayout | null;
  /** A populated conversation defaults Chat visible when it has no explicit
   * remembered visibility of its own. */
  targetHasMessages?: boolean;
  opts?: { autosend?: boolean; view?: string };
  /** `?autosend` sentinel value, injected to avoid an import cycle. */
  autosendValue: string;
}

/** Where the switch lands: the view, and the search that describes the rest. */
export interface TaskSwitchTarget {
  /** Main-panel view as a tab id; `undefined` leaves the target on its default. */
  tabId: string | undefined;
  search: Record<string, unknown>;
}

export function resolveTaskSwitchSearch(
  input: ResolveTaskSwitchInput,
): TaskSwitchTarget {
  const {
    prev,
    targetAgentId,
    decopilotId,
    savedLayout,
    targetHasMessages,
    opts,
    autosendValue,
  } = input;

  /** Written even when empty: a `mainpanel` from the thread being left must
   *  not describe the one being opened. */
  const next: Record<string, unknown> = { mainpanel: undefined };

  // The Super Agent (Decopilot) is the default when the route names no agent,
  // so treat an absent id as Decopilot on BOTH sides —
  // otherwise switching FROM the param-less Super Agent TO a repo agent isn't
  // detected as a switch and wrongly carries the previous view forward.
  const previousAgentId = prev.agentId ?? decopilotId;
  const nextAgentId = targetAgentId ?? previousAgentId;
  const isAgentSwitch = nextAgentId !== previousAgentId;

  /** Pin a panel value only when the target thread remembered one: leaving it
   *  undefined omits the key, so `resolveDefaultPanelState`'s agent-configured
   *  default applies rather than forcing a panel open. */
  let sidepanel: boolean | undefined;
  let tabId: string | undefined;

  if (opts?.view) {
    // Explicit intent wins outright — ignore saved/carried layout.
    tabId = opts.view;
  } else if (savedLayout) {
    // Restore the target thread's own layout. A remembered per-thread tab is
    // valid here because it belongs to *this* thread; route capability guards
    // send a stale native view to Settings without crashing the workspace.
    tabId = savedLayout.tab;
    if (savedLayout.sidepanel !== undefined) sidepanel = savedLayout.sidepanel;
    if (savedLayout.mainpanel !== undefined) {
      next.mainpanel = savedLayout.mainpanel;
    }
  } else if (!isAgentSwitch && prev.tabId && !isPerThreadTab(prev.tabId)) {
    tabId = prev.tabId;
  }

  if (sidepanel !== undefined) next.sidepanel = sidepanel;
  else if (targetHasMessages) next.sidepanel = true;
  if (opts?.autosend) next.autosend = autosendValue;
  return { tabId, search: next };
}
