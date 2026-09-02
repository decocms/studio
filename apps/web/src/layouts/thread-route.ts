/**
 * Where the open thread's id lives, for whichever route is matched.
 *
 * Path = which page, search = how that page is laid out. A thread is layout, so
 * on every destination (`/$org/home`, `/$org/agents/{-$project}`, …) it travels
 * as `?thread=`, the key the agent shell declares. The legacy `/$org/$taskId`
 * carries the same id in its path param instead and stays mounted forever, and
 * routes outside the agent shell (the settings tree, whose sidebar still offers
 * "new chat") carry no thread at all, so a switch there has to land on the
 * legacy route.
 *
 * Panel actions that do NOT change the thread (open a tab, toggle a panel) must
 * not come through here at all: they navigate `to: "."`, which re-interpolates
 * the current path params and so cannot fabricate a thread id.
 */

import {
  useMatch,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  DESTINATION_ROUTE,
  useLeafRoutePath,
} from "@/hooks/use-destination-route";
import {
  clearPanelPayload,
  panelLocationForTab,
} from "@/layouts/main-panel-tabs/panel-route";
import { getWellKnownDecopilotVirtualMCP, useProjectContext } from "@/sdk";

/**
 * The pathless layout that owns `main`/`sidepanel`/`thread`. Typed against the
 * route tree, so restructuring the shell is a compile error here, not a silent
 * fallback at runtime.
 */
const AGENT_SHELL_ROUTE_ID = "/shell/$org/org-shell/agent-shell" as const;

/** Builds the next search from the previous, exactly as TanStack's `navigate` expects. */
export type ThreadSearchFn = (
  prev: Record<string, unknown>,
) => Record<string, unknown>;

/** Where a thread switch lands. `"."` = stay on the matched route. */
export type ThreadNavTarget =
  | { to: "/$org/$taskId"; params: { org: string; taskId: string } }
  | { to: "." };

/**
 * Pure core of {@link useThreadNavigate}.
 *
 * An empty `threadId` never resolves to the legacy route: interpolating it
 * would produce `/$org/` and silently leave the workspace.
 */
export function resolveThreadNavTarget(input: {
  /** The matched route carries the thread as `?thread=` rather than in its path. */
  threadInSearch: boolean;
  orgSlug: string;
  threadId: string;
}): ThreadNavTarget {
  if (input.threadInSearch || !input.threadId) return { to: "." };
  return {
    to: "/$org/$taskId",
    params: { org: input.orgSlug, taskId: input.threadId },
  };
}

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

/** The thread id for the matched route, from either the path param or `?thread=`. */
export function useRouteThreadId(): string | null {
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false });
  return resolveRouteThreadId({
    taskIdParam: params.taskId,
    threadSearch: search.thread,
  });
}

/** Pure core of {@link useRouteAgentId}: the ONE answer to "which agent does
 *  this route name", where naming none is real (`undefined`).
 *
 *  Three routes resolve `?virtualmcpid=`, and no more: the agents route, the
 *  legacy `/$org/$taskId`, and HOME — whose face IS the scope's (`HomeTab`
 *  renders the scoped project's overview, the roster only when unscoped). The
 *  gate is the point: the param is retained so one scope can narrow Tasks and
 *  Library, so resolving it everywhere would let a leftover param turn an
 *  org-level page into a project workspace.
 *
 *  Home was missing, and it mattered: `useNavigateToAgent` sends an agent with
 *  no panel to `/$org/home?virtualmcpid=X&thread=<new>`, so the thread was
 *  minted for X and then CREATED against the Super Agent — and chat dispatched
 *  there too. */
export function resolveRouteAgentId(input: {
  virtualMcpIdSearch?: string;
  /** True on `/$org/agents/{-$panel}`, whose agent is the scope. */
  onAgentsRoute?: boolean;
  /** True on `/$org/home`, which renders the scoped project's own overview. */
  onHomeRoute?: boolean;
  /** True only on `/$org/$taskId`, the one route whose agent lives in search. */
  legacyRoute?: boolean;
}): string | undefined {
  return input.onAgentsRoute || input.onHomeRoute || input.legacyRoute
    ? input.virtualMcpIdSearch || undefined
    : undefined;
}

/** True on the legacy `/$org/$taskId`, whose thread id is its path param. */
function useLegacyThreadRoute(): boolean {
  const params = useParams({ strict: false });
  return params.taskId !== undefined;
}

/** The agent the matched route names, or `undefined` when it names none. */
export function useRouteAgentId(): string | undefined {
  const search = useSearch({ strict: false }) as { virtualmcpid?: string };
  const leafPath = useLeafRoutePath();
  const legacyRoute = useLegacyThreadRoute();
  return resolveRouteAgentId({
    virtualMcpIdSearch: search.virtualmcpid,
    onAgentsRoute: leafPath === DESTINATION_ROUTE.agents,
    onHomeRoute: leafPath === DESTINATION_ROUTE.home,
    legacyRoute,
  });
}

/** The agent the matched route scopes to; the org's Super Agent when it names none. */
export function useRouteVirtualMcpId(): string {
  const { org } = useProjectContext();
  const routeAgentId = useRouteAgentId();
  return routeAgentId ?? getWellKnownDecopilotVirtualMCP(org.id).id;
}

/** Pure core of the destination branch of {@link useThreadNavigate}. Switching
 *  threads keeps the page you are on, so its own search survives — panel state,
 *  board filters, Library path — and `changes` layers OVER `prev` rather than
 *  replacing it, with `thread` written last. A switch never INTRODUCES a scope
 *  (`virtualmcpid` is dropped from `changes`, so opening someone else's thread
 *  cannot scope the page to that thread's project), but a scope already in
 *  `prev` SURVIVES: it is the filter the person chose, and deleting it would be
 *  futile anyway since retention re-adds it. */
export function resolveDestinationThreadSearch(input: {
  prev: Record<string, unknown>;
  changes: Record<string, unknown>;
  threadId: string;
}): Record<string, unknown> {
  const { virtualmcpid: _introduced, ...changes } = input.changes;
  return { ...input.prev, ...changes, thread: input.threadId };
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
 * Where a destination thread switch lands: `"stay"` keeps the matched route and
 * names the `{-$project}` segment it should now carry, `"relocate"` leaves for
 * the agents route because the matched page cannot hold the target agent.
 */
export type DestinationSwitch =
  | { kind: "stay"; project: string | undefined }
  | { kind: "relocate"; project: string };

/**
 * Pure core of the `{-$project}` half of a destination thread switch.
 *
 * A thread belongs to exactly one agent, and under this grammar the agent IS
 * the path segment — so the switch has to put the page on the segment the
 * target thread's agent owns:
 *
 *  - a route that already names a project MOVES its segment. Leaving it while
 *    showing another project's conversation would run that chat against this
 *    project's tools, sandbox and branch.
 *  - an org-level destination (Home, Tasks, Reports, Library, and a bare
 *    `/$org/agents`) has no segment at all, because it belongs to the Super
 *    Agent. Another agent's thread cannot be shown there without smuggling the
 *    agent into search, which is exactly what `?virtualmcpid=` used to do. So
 *    the switch RELOCATES to that agent's own workspace: a thread belongs where
 *    its agent lives.
 *
 * The Super Agent is not a project, so a switch to one of its threads carries
 * no segment — a project route drops its own rather than minting a
 * `/agents/decopilot_…` segment for something that is not a project at all.
 */
export function resolveDestinationSwitch(input: {
  currentProject?: string;
  targetVirtualMcpId?: string;
  decopilotId?: string;
}): DestinationSwitch {
  /** A switch that names no agent moves nothing: the page keeps its scope. */
  if (input.targetVirtualMcpId === undefined) {
    return { kind: "stay", project: input.currentProject };
  }
  const project =
    input.targetVirtualMcpId === input.decopilotId
      ? undefined
      : input.targetVirtualMcpId;
  if (project !== undefined && input.currentProject === undefined) {
    return { kind: "relocate", project };
  }
  return { kind: "stay", project };
}

/** True on a destination route: inside the agent shell, with no `$taskId` in the path. */
function useThreadInSearch(): boolean {
  const params = useParams({ strict: false });
  const agentShellMatch = useMatch({
    from: AGENT_SHELL_ROUTE_ID,
    shouldThrow: false,
  });
  return !!agentShellMatch && params.taskId === undefined;
}

/**
 * Navigate to another thread without leaving the matched route shape: a
 * destination gets `?thread=`, everything else lands on `/$org/$taskId`.
 *
 * `searchFn` owns the rest of the search; `thread` is written last so it always
 * describes the thread being navigated to. `opts.virtualMcpId` names the agent
 * the target thread belongs to, which is what moves the `{-$project}` segment
 * when that thread lives in another project — or leaves an org-level page for
 * that project's workspace, an org-level page having no segment to move — and
 * `opts.view` names the main panel view to land on: omit it to keep whatever
 * the current URL shows.
 */
export function useThreadNavigate() {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const threadInSearch = useThreadInSearch();
  const { org } = useProjectContext();
  const orgSlug = params.org ?? "";
  const onAgentsRoute = useLeafRoutePath() === DESTINATION_ROUTE.agents;
  const routeSearch = useSearch({ strict: false }) as {
    virtualmcpid?: string;
  };
  /** The scope only names the workspace's agent ON the agents route; elsewhere
   *  it is an ambient filter and this navigation is org-level. */
  const currentProject = onAgentsRoute ? routeSearch.virtualmcpid : undefined;
  const currentPanel = params.panel;
  const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;

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
    const target = resolveThreadNavTarget({
      threadInSearch,
      orgSlug,
      threadId,
    });
    const replace = opts?.replace ?? false;

    if (target.to === "/$org/$taskId") {
      return navigate({
        to: target.to,
        params: target.params,
        search: searchFn,
        replace,
      });
    }

    const switchTo = resolveDestinationSwitch({
      currentProject,
      targetVirtualMcpId: opts?.virtualMcpId,
      decopilotId,
    });
    /** A view the caller named is written as the `{-$panel}` segment plus its
     *  payload — the same pair `panel-route.ts` writes everywhere else. */
    const view =
      opts?.view && opts.view.tabId !== undefined
        ? panelLocationForTab(opts.view.tabId)
        : opts?.view
          ? { panel: undefined, payload: clearPanelPayload() }
          : null;
    /** Only layout crosses a page boundary. Two destinations that both declare
     *  a key (`?preview=` on the agents route and on Library) mean different
     *  things by it, so the page being left keeps its own search to itself. */
    const crossPage = switchTo.kind === "relocate" && !onAgentsRoute;

    const search = (prev: Record<string, unknown>) =>
      resolveDestinationThreadSearch({
        prev: crossPage ? { sidepanel: prev.sidepanel } : prev,
        changes: { ...searchFn(prev), ...(view?.payload ?? {}) },
        threadId,
      });

    if (switchTo.kind === "relocate") {
      return navigate({
        to: DESTINATION_ROUTE.agents,
        params: {
          org: orgSlug,
          panel: view ? view.panel : currentPanel,
        },
        search: (prev: Record<string, unknown>) => ({
          ...(typeof search === "function" ? search(prev) : search),
          virtualmcpid: switchTo.project,
        }),
        replace,
      });
    }

    return navigate({
      to: ".",
      params: (prev: Record<string, unknown>) =>
        view ? { ...prev, panel: view.panel } : prev,
      search: (prev: Record<string, unknown>) => ({
        ...(typeof search === "function" ? search(prev) : search),
        ...(onAgentsRoute ? { virtualmcpid: switchTo.project } : {}),
      }),
      replace,
    });
  };
}
