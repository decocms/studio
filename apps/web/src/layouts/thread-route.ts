/**
 * Where the open thread's id lives, for whichever route is matched.
 *
 * Path = which page, search = how that page is laid out. A thread is layout, so
 * on every destination (`/$org/home`, `/$org/chat/{-$project}`, …) it travels
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

/**
 * Pure core of {@link useRouteVirtualMcpId} — the ONE answer to "which agent is
 * this workspace scoped to". The shell, the breadcrumb and the new-chat control
 * all read it, so they can no longer disagree about the scope the way they did
 * while each re-derived it from a different half of the URL.
 *
 * Path beats search, because path = which page. On a destination the
 * `{-$project}` segment IS the scope, so a `?virtualmcpid=` surviving from the
 * legacy grammar is vestigial there and must never override it. The legacy
 * `/$org/$taskId` route carries no project segment, so it still reads its agent
 * from `?virtualmcpid=` exactly as before.
 */
export function resolveRouteVirtualMcpId(input: {
  projectParam?: string;
  virtualMcpIdSearch?: string;
  decopilotId: string;
}): string {
  return input.projectParam ?? input.virtualMcpIdSearch ?? input.decopilotId;
}

/** The agent the matched route scopes to; the org's Super Agent when it names none. */
export function useRouteVirtualMcpId(): string {
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false });
  const { org } = useProjectContext();
  return resolveRouteVirtualMcpId({
    projectParam: params.project,
    virtualMcpIdSearch: search.virtualmcpid,
    decopilotId: getWellKnownDecopilotVirtualMCP(org.id).id,
  });
}

/**
 * Pure core of the destination branch of {@link useThreadNavigate}.
 *
 * Switching threads on a destination keeps the page you are on, so the page's
 * own search survives: panel state, board filters, Library path. `changes`
 * carries only what the switch itself decided, so it layers OVER `prev` rather
 * than replacing it, and `thread` is written last so it always names the thread
 * being navigated to.
 *
 * `projectInPath` drops `virtualmcpid`: once the path names the project, a
 * legacy agent param can only contradict it — which is exactly how a new chat
 * started on a project used to land on the Super Agent. Destinations with no
 * project segment (Home, Reports, Library) keep carrying it, since there the
 * search key is the only record of the agent.
 */
export function resolveDestinationThreadSearch(input: {
  prev: Record<string, unknown>;
  changes: Record<string, unknown>;
  threadId: string;
  projectInPath: boolean;
}): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...input.prev,
    ...input.changes,
    thread: input.threadId,
  };
  if (input.projectInPath) delete next.virtualmcpid;
  return next;
}

/**
 * The agent a surface should act on, where "no agent named anywhere" is a real
 * answer (`null`) rather than the Super Agent — the thread list, whose new-chat
 * button and active-agent highlight both read it.
 *
 * Same precedence as {@link resolveRouteVirtualMcpId} — path, then the legacy
 * search param — with the open thread's own agent behind them, which is the
 * only source on a destination that names neither (Home, Reports, Library).
 */
export function resolveActiveAgentId(input: {
  projectParam?: string;
  virtualMcpIdSearch?: string;
  threadVirtualMcpId?: string | null;
}): string | null {
  return (
    input.projectParam ??
    input.virtualMcpIdSearch ??
    input.threadVirtualMcpId ??
    null
  );
}

/**
 * Pure core of the `{-$project}` half of a destination thread switch.
 *
 * A thread belongs to exactly one agent, and on a project destination the path
 * segment IS that agent — so a switch to a thread owned by ANOTHER project has
 * to move the segment. Dropping `virtualmcpid` without moving it would leave
 * the page scoped to the project it still names while showing a conversation
 * that belongs to a different one: the chat would run its tools, its sandbox
 * and its branch.
 *
 * `undefined` in, `undefined` out: a route with no segment (Home, Reports,
 * Library, and the deliberate all-projects `/$org/tasks`) has no project axis
 * to move, and there `virtualmcpid` stays the record of the agent. The Super
 * Agent is not a project either, so its threads land on that same segmentless
 * form rather than minting a `/chat/decopilot_…` segment for something that is
 * not a project at all.
 */
export function resolveDestinationProject(input: {
  currentProject?: string;
  targetVirtualMcpId?: string;
  decopilotId?: string;
}): string | undefined {
  if (input.currentProject === undefined) return undefined;
  const next = input.targetVirtualMcpId ?? input.currentProject;
  return next === input.decopilotId ? undefined : next;
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
 * when that thread lives in another project.
 */
export function useThreadNavigate() {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const threadInSearch = useThreadInSearch();
  const { org } = useProjectContext();
  const orgSlug = params.org ?? "";
  const currentProject = params.project;
  const projectInPath = currentProject !== undefined;
  const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;

  return (
    threadId: string,
    searchFn: ThreadSearchFn,
    opts?: { replace?: boolean; virtualMcpId?: string },
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

    const nextProject = resolveDestinationProject({
      currentProject,
      targetVirtualMcpId: opts?.virtualMcpId,
      decopilotId,
    });

    return navigate({
      to: ".",
      params: (prev: Record<string, unknown>) =>
        projectInPath ? { ...prev, project: nextProject } : prev,
      search: (prev: Record<string, unknown>) =>
        resolveDestinationThreadSearch({
          prev,
          changes: searchFn(prev),
          threadId,
          projectInPath,
        }),
      replace,
    });
  };
}
