/**
 * Where the open thread's id lives, for whichever route is matched.
 *
 * Path = which page, search = how that page is laid out. A thread is layout, so
 * on every route under the workspace shell it travels as `?thread=`. The
 * forever-supported `/$org/$taskId` input carries that same id in its path only
 * until the compatibility adapter promotes it to a canonical destination.
 *
 * Panel actions that do NOT change the thread (open a tab, toggle a panel) must
 * not come through here at all: they navigate `to: "."`, which re-interpolates
 * the current path params and so cannot fabricate a thread id.
 */

import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  getWellKnownDecopilotVirtualMCP,
  isDecopilot,
  useProjectContext,
} from "@/sdk";
import {
  canonicalThreadRouteTarget,
  navigateToTabRouteTarget,
} from "@/layouts/main-panel-tabs/tab-route";

/** Builds the next search from the previous, exactly as TanStack's `navigate` expects. */
export type ThreadSearchFn = (
  prev: Record<string, unknown>,
) => Record<string, unknown>;

/**
 * Pure core of {@link useRouteThreadId}. `null` means "this route names no
 * thread" — the state every destination is in until one is opened. It is a
 * distinct type from an id on purpose: nothing downstream can subscribe, fetch
 * or report against an absent thread without narrowing it away first.
 */
export function resolveRouteThreadId(input: {
  taskIdParam?: string;
  threadSearch?: string;
}): string | null {
  return input.taskIdParam ?? input.threadSearch ?? null;
}

/** A canonical agent URL may only mount a thread owned by that same agent.
 *  Missing ownership is tolerated for legacy/partial records; a concrete
 *  mismatch must be removed before chat or runtime providers see the row. */
export function routeThreadMatchesAgent(input: {
  routeAgentId: string;
  threadAgentId?: string | null;
}): boolean {
  return (
    input.threadAgentId == null || input.threadAgentId === input.routeAgentId
  );
}

export type ThreadOwnerDestination =
  | { kind: "home" }
  | { kind: "agent"; agentId: string };

/** Canonical landing for a thread whose loaded ownership disagrees with the
 * provisional route. Home is the Super Agent's default/overview surface;
 * every regular agent owns an explicit workspace path. */
export function destinationForThreadOwner(
  threadAgentId: string,
): ThreadOwnerDestination {
  const agentId = threadAgentId.trim();
  if (!agentId || isDecopilot(agentId)) return { kind: "home" };
  return { kind: "agent", agentId };
}

/** The thread id for the matched route, from either the path param or `?thread=`. */
export function useRouteThreadId(): string | null {
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false });
  return resolveRouteThreadId({
    taskIdParam: params.taskId,
    threadSearch: search.thread,
  });
}

/** Pure core of {@link useRouteAgentId}. Canonical identity comes from the
 *  route path. Search is consulted only while the forever-mounted legacy
 *  `/$org/$taskId` adapter is settling. */
export function resolveRouteAgentId(input: {
  /** Canonical `/$org/agents/$agentId/...` identity. */
  agentIdParam?: string;
  virtualMcpIdSearch?: string;
  /** True only on `/$org/$taskId`, the one route whose agent lives in search. */
  legacyRoute?: boolean;
}): string | undefined {
  const pathAgentId = input.agentIdParam?.trim();
  if (pathAgentId) return pathAgentId;
  const legacyAgentId = input.virtualMcpIdSearch?.trim();
  return input.legacyRoute ? legacyAgentId || undefined : undefined;
}

/** True on the legacy `/$org/$taskId`, whose thread id is its path param. */
function useLegacyThreadRoute(): boolean {
  const params = useParams({ strict: false });
  return params.taskId !== undefined;
}

/** The agent the matched route names, or `undefined` when it names none. */
export function useRouteAgentId(): string | undefined {
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false });
  const virtualMcpIdSearch =
    "virtualmcpid" in search && typeof search.virtualmcpid === "string"
      ? search.virtualmcpid
      : undefined;
  const legacyRoute = useLegacyThreadRoute();
  return resolveRouteAgentId({
    agentIdParam: params.agentId,
    virtualMcpIdSearch,
    legacyRoute,
  });
}

/** The agent the matched route scopes to; the org's Super Agent when it names none. */
export function useRouteVirtualMcpId(): string {
  const { org } = useProjectContext();
  const routeAgentId = useRouteAgentId();
  return routeAgentId ?? getWellKnownDecopilotVirtualMCP(org.id).id;
}

/** Pure search merge for {@link useThreadNavigate}. Route-owned state survives
 * a same-page switch, legacy routing keys never do, and `thread` is
 * authoritative over every caller payload. */
export function resolveDestinationThreadSearch(input: {
  prev: Record<string, unknown>;
  changes: Record<string, unknown>;
  threadId: string;
}): Record<string, unknown> {
  const {
    virtualmcpid: _previousAgent,
    main: _previousView,
    ...previous
  } = input.prev;
  const {
    virtualmcpid: _introducedAgent,
    main: _introducedView,
    ...changes
  } = input.changes;
  return { ...previous, ...changes, thread: input.threadId };
}

/**
 * The agent a surface should act on, where "no agent named anywhere" is a real
 * answer (`null`) rather than the Super Agent — the thread list, whose new-chat
 * button and active-agent highlight both read it.
 *
 * The route answers first (see {@link resolveRouteAgentId}), with the open
 * thread's own agent behind it, which is the only source left on an org-level
 * destination.
 */
export function resolveActiveAgentId(input: {
  routeAgentId?: string;
  threadVirtualMcpId?: string | null;
}): string | null {
  return input.routeAgentId ?? input.threadVirtualMcpId ?? null;
}

/**
 * Navigate to another thread. A same-agent switch preserves the current
 * route-owned page; a cross-agent switch moves to that agent's canonical root.
 *
 * `searchFn` owns the remaining shared search; `thread` is written last so it
 * always describes the selected thread. `opts.view` can choose another
 * route-owned page through the one tab-to-route mapper.
 */
export function useThreadNavigate() {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const { org } = useProjectContext();
  const orgSlug = params.org ?? "";
  const currentAgentId = params.agentId;
  const fallbackAgentId = useRouteVirtualMcpId();
  const superAgentId = getWellKnownDecopilotVirtualMCP(org.id).id;

  return (
    threadId: string,
    searchFn: ThreadSearchFn,
    opts?: {
      replace?: boolean;
      virtualMcpId?: string;
      /** The view to land on, as a tab id; `{ tabId: undefined }` clears it. */
      view?: { tabId: string | undefined };
    },
  ) => {
    const replace = opts?.replace ?? false;
    const targetAgentId = opts?.virtualMcpId ?? currentAgentId;
    const staysOnCurrentRoute =
      opts?.view === undefined &&
      params.taskId === undefined &&
      (targetAgentId === undefined || targetAgentId === currentAgentId);

    const canonicalSearch =
      (crossesRoute: boolean) => (prev: Record<string, unknown>) => ({
        ...resolveDestinationThreadSearch({
          prev: crossesRoute ? { sidepanel: prev.sidepanel } : prev,
          changes: searchFn(prev),
          threadId,
        }),
      });

    if (staysOnCurrentRoute) {
      return navigate({
        to: ".",
        search: canonicalSearch(false),
        replace,
      });
    }

    const target = canonicalThreadRouteTarget({
      org: orgSlug,
      agentId: targetAgentId ?? fallbackAgentId,
      superAgentId,
      tabId: opts?.view?.tabId,
    });
    return navigateToTabRouteTarget(navigate, target, {
      search: canonicalSearch(true),
      replace,
    });
  };
}
