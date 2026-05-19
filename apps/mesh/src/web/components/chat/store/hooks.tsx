/**
 * React hook layer over ThreadManagerStore.
 *
 * `ThreadManagerProvider` constructs (or reuses) the module-scoped manager via
 * `getOrOpenManager(orgSlug, locator, { client })`. Because the registry keys
 * on `${orgSlug}::${locator}`, repeated provider renders return the same
 * instance — no `useEffect` is needed to gate construction.
 *
 * The leaf hooks wrap the manager's `Store<T>` slots with
 * `useSyncExternalStore`. When a hook subscribes to an *optional* slot (e.g.
 * the active conn's `messages`), it falls back to module-scoped stable
 * `noopSubscribe` / default-getter pairs so `useSyncExternalStore`'s
 * reference-identity rules hold per render.
 */

import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import type { UIMessage } from "ai";
import {
  createContext,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from "react";
import type { Task } from "../task/types";
import type { ConnStatus, ThreadConnection } from "./thread-connection";
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
  const manager = getOrOpenManager(org.slug, locator, { client });
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

export function useThreads(): { threads: Task[]; status: ThreadsStatus } {
  const m = useThreadManager();
  const threads = useSyncExternalStore(m.threads.subscribe, m.threads.get);
  const status = useSyncExternalStore(
    m.threadsStatus.subscribe,
    m.threadsStatus.get,
  );
  return { threads, status };
}

export function useThreadStatus(): ThreadsStatus {
  const m = useThreadManager();
  return useSyncExternalStore(m.threadsStatus.subscribe, m.threadsStatus.get);
}

export function useActiveThread(): ThreadConnection | null {
  const m = useThreadManager();
  return useSyncExternalStore(m.active.subscribe, m.active.get);
}

export function useThreadMessages(): UIMessage[] {
  const conn = useActiveThread();
  return useSyncExternalStore(
    conn?.messages.subscribe ?? noopSubscribe,
    conn?.messages.get ?? returnEmptyArray,
  );
}

export function useThreadConnStatus(): ConnStatus {
  const conn = useActiveThread();
  return useSyncExternalStore(
    conn?.status.subscribe ?? noopSubscribe,
    conn?.status.get ?? returnLoading,
  );
}

export function useFinishReason(): string | null {
  const conn = useActiveThread();
  return useSyncExternalStore(
    conn?.finishReason.subscribe ?? noopSubscribe,
    conn?.finishReason.get ?? returnNull,
  );
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

// ─── Stable fallbacks for optional active-conn subscriptions ─────────────────

const noopSubscribe = () => () => {};
const EMPTY_MESSAGES: UIMessage[] = [];
const returnEmptyArray = (): UIMessage[] => EMPTY_MESSAGES;
const LOADING_STATUS: ConnStatus = { kind: "loading" };
const returnLoading = (): ConnStatus => LOADING_STATUS;
const returnNull = (): string | null => null;
