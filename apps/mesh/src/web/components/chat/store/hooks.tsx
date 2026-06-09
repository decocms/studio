/**
 * React hook layer over ThreadManagerStore.
 *
 * `ThreadManagerProvider` constructs (or reuses) the module-scoped manager via
 * `getOrOpenManager(orgSlug, locator, { client })`. Because the registry keys
 * on `${orgSlug}::${locator}`, repeated provider renders return the same
 * instance — no `useEffect` is needed to gate construction.
 *
 * Only the hooks actually consumed by call sites are exported. Per-thread
 * subscriptions (messages, conn status, finishReason) go through
 * `getOrOpenStream(...)` + `useSyncExternalStore` directly in chat-context;
 * adding hook wrappers here would be dead public surface until something
 * needs them.
 */

import {
  getWellKnownDecopilotVirtualMCP,
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { buildMockTasks } from "@/web/views/deco-redesign/mock-threads";
import {
  createContext,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from "react";
import type { Task } from "../task/types";
import {
  getOrOpenManager,
  type ThreadManagerStore,
  type ThreadsStatus,
} from "./thread-manager-store";

const ManagerContext = createContext<ThreadManagerStore | null>(null);

export function ThreadManagerProvider({ children }: { children: ReactNode }) {
  const { org, locator } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  // Redesign mock: System Health findings as real tasks under the Deco agent.
  const seeds = buildMockTasks(getWellKnownDecopilotVirtualMCP(org.id).id);
  const manager = getOrOpenManager(org.slug, locator, {
    client,
    seedTasks: seeds,
  });
  // Ensure the findings are present even if this manager instance predates the
  // seeds (HMR / earlier construction). Idempotent — merges once.
  manager.ensureSeeded(seeds);
  return (
    <ManagerContext.Provider value={manager}>
      {children}
    </ManagerContext.Provider>
  );
}

export function useThreadManager(): ThreadManagerStore {
  const m = useContext(ManagerContext);
  if (!m) throw new Error("useThreadManager: missing ThreadManagerProvider");
  return m;
}

/**
 * Non-throwing variant. Returns null outside a `ThreadManagerProvider` (e.g.
 * the settings route tree, which mounts under `orgLayout` rather than
 * `orgShellLayout`). Use this for navigation-only consumers that should work
 * everywhere but only need the manager for thread mutations.
 */
export function useOptionalThreadManager(): ThreadManagerStore | null {
  return useContext(ManagerContext);
}

export function useThreads(): {
  threads: Task[];
  status: ThreadsStatus;
  hasMore: boolean;
  isFetchingMore: boolean;
  fetchNextPage: () => Promise<void>;
} {
  const m = useThreadManager();
  const threads = useSyncExternalStore(m.threads.subscribe, m.threads.get);
  const status = useSyncExternalStore(
    m.threadsStatus.subscribe,
    m.threadsStatus.get,
  );
  const hasMore = useSyncExternalStore(m.hasMore.subscribe, m.hasMore.get);
  const isFetchingMore = useSyncExternalStore(
    m.isFetchingMore.subscribe,
    m.isFetchingMore.get,
  );
  return {
    threads,
    status,
    hasMore,
    isFetchingMore,
    fetchNextPage: m.fetchNextPage.bind(m),
  };
}

export function useThreadActions() {
  const m = useThreadManager();
  return {
    create: m.create.bind(m),
    rename: m.rename.bind(m),
    hide: m.hide.bind(m),
    setStatus: m.setStatus.bind(m),
    setBranch: m.setBranch.bind(m),
    setActive: m.setActive.bind(m),
    closeActive: m.closeActive.bind(m),
  };
}
