/**
 * useNavigateToAgent — navigates to an agent and adds it to the sidebar.
 *
 * Shared hook used by sidebar, home page, and /agents route to handle
 * agent navigation with automatic personal sidebar membership.
 */

import { DESTINATION_ROUTE } from "@/hooks/use-destination-route";
import { panelLocationForTab } from "@/layouts/main-panel-tabs/panel-route";
import {
  fetchVirtualMCPs,
  useProjectContext,
  useVirtualMCPsNonBlocking,
} from "@/sdk";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { useOptionalThreadManager } from "@/components/chat/store/hooks";
import type { Task } from "@/components/chat/task/types";
import { findAgentEntryThread } from "@/lib/reusable-new-chat";
import { getActiveGithubRepo } from "@/lib/github-repo";
import {
  draftsModeEnabled,
  useBaseBranch,
} from "@/components/thread/github/use-version-gate";
import {
  defaultThreadRuntime,
  type ThreadRuntime,
} from "@decocms/shared/thread/session-runtime";
import { writeThreadIntent } from "@/lib/thread-intent";

const NO_THREADS: Task[] = [];

interface NavigateToAgentOptions {
  /** Main-panel view to land on, as a tab id. Written as the chat route's
   *  `{-$panel}` segment (plus its payload), never as search. */
  panel?: string;
  /** The runtime the landed-on session must be. A thread's runtime is stamped
   *  once at creation and immutable, so this both picks which empty chat can be
   *  reused and is parked as an intent for the create the route loader runs —
   *  without it, "open the CMS" could resume a sandbox session, or mint one. */
  runtime?: ThreadRuntime;
}

export function useNavigateToAgent() {
  const navigate = useNavigate();
  const { org, locator } = useProjectContext();
  const queryClient = useQueryClient();
  /** NON-BLOCKING, deliberately. This list answers exactly one question — the
   *  agent's default runtime — and only at CLICK time. Reading it with
   *  `useVirtualMCPs()` put a suspense read in the sidebar, which has no
   *  boundary of its own, so a re-suspend blanked the whole shell. `[]` here is
   *  not a wrong answer; it means "ask again on click". */
  const cachedAgents = useVirtualMCPsNonBlocking();
  const { data: session } = authClient.useSession();
  /** The open-thread list is read at CLICK time, off the store. Subscribing
   *  re-rendered every sidebar row for a value nothing renders, and the
   *  snapshot a click needs is the one at the click. */
  const manager = useOptionalThreadManager();
  /** Cold-entry base ("main"): no current branch to resolve a PR base from. */
  const baseBranch = useBaseBranch(undefined, null);

  /** The navigation proper, once the wanted runtime is known. */
  const go = (
    virtualMcpId: string,
    options: NavigateToAgentOptions | undefined,
    wantedRuntime: ThreadRuntime | undefined,
  ) => {
    /** Resume the agent's ENTRY thread — its last branch for a repo-backed
     *  agent, otherwise its empty chat — and mint a fresh id only when there is
     *  none. `wantedRuntime` narrows which empty chat qualifies, so "open the
     *  CMS" cannot resume a sandbox session. */
    const target = (cachedAgents ?? []).find((a) => a.id === virtualMcpId);
    const hasBranch = !!(target && getActiveGithubRepo(target));
    /** An agent's entry thread (its last branch/version for a repo editor, its
     *  last conversation for a plain chat) can only be resolved from the TARGET
     *  project's thread list. The manager here is keyed on `${org}::${locator}`,
     *  so at a cross-project surface (org home, another project's sidebar) it is
     *  a different-scoped instance that can't see this agent's threads. Resolving
     *  against it always misses and mints a fresh id — a new chat/production
     *  thread every visit. So we omit `thread` from the URL and let the shell's
     *  loading-guarded resolver (agent-shell-layout), which runs in the project's
     *  own scope, own it. We keep resolving here only when a specific runtime was
     *  requested: that path parks a runtime intent the shell resolver can't read. */
    const delegateEntryToShell = !options?.runtime;
    const entry = delegateEntryToShell
      ? undefined
      : findAgentEntryThread(
          manager?.threads.get() ?? NO_THREADS,
          virtualMcpId,
          session?.user?.id,
          wantedRuntime ??
            (target ? defaultThreadRuntime(target.metadata) : undefined),
          hasBranch,
          {
            knownBranches: new Set<string>([
              baseBranch,
              ...(target?.metadata?.releases ?? []).map((r) => r.branch),
            ]),
            draftsMode: draftsModeEnabled(target),
          },
        );
    const taskId = delegateEntryToShell
      ? undefined
      : (entry?.id ?? crypto.randomUUID());
    /** Park the runtime for the create the route loader will run. Only for a
     *  fresh id — a resumed thread is already stamped, and re-parking would
     *  leave an unclaimed key behind. `taskId` is undefined when delegating. */
    if (taskId && !entry && options?.runtime) {
      writeThreadIntent(sessionStorage, locator, taskId, {
        runtime: options.runtime,
      });
    }
    /** No `taskId` → omit `thread` and let the shell resolver add it. */
    const threadSearch = taskId ? { thread: taskId } : {};
    const view = options?.panel ? panelLocationForTab(options.panel) : null;
    /**
     * An agent that names no view goes to Home, never to a bare `/agents` with
     * no segment: that URL has a thread and a project but no view, so it opens
     * the workspace on whatever the panel machinery happens to pick. Home is a
     * real page and says so in the address.
     */
    if (!view?.panel) {
      navigate({
        to: DESTINATION_ROUTE.home,
        params: { org: org.slug },
        search: { virtualmcpid: virtualMcpId, ...threadSearch },
      });
      return;
    }
    navigate({
      to: DESTINATION_ROUTE.agents,
      params: { org: org.slug, panel: view.panel },
      search: {
        ...view.payload,
        virtualmcpid: virtualMcpId,
        ...threadSearch,
      },
    });
  };

  return (virtualMcpId: string, options?: NavigateToAgentOptions) => {
    // Both of these answer without awaiting, in the click's own task.
    const cached = cachedAgents.find((a) => a.id === virtualMcpId);
    if (options?.runtime) {
      return go(virtualMcpId, options, options.runtime);
    }
    if (cached) {
      return go(virtualMcpId, options, defaultThreadRuntime(cached.metadata));
    }
    /** Cold cache — a click in the first beat after load. Fetch rather than
     *  pass `undefined`: an absent expected runtime makes `runtimeMatches` match
     *  ANY empty chat, which is how a click on a CMS project lands in a
     *  leftover sandbox session. On failure fall back to that unfiltered
     *  behaviour, which is the status quo. */
    void fetchVirtualMCPs(queryClient, org)
      .then((agents) => agents.find((a) => a.id === virtualMcpId))
      .catch(() => undefined)
      .then((target) =>
        go(
          virtualMcpId,
          options,
          target ? defaultThreadRuntime(target.metadata) : undefined,
        ),
      );
  };
}
