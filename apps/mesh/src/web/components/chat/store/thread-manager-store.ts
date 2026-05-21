import type { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import { toast } from "sonner";
import {
  DECOPILOT_EVENTS,
  type DecopilotThreadStatusEvent,
} from "@decocms/mesh-sdk";
import type {
  ThreadCreateData,
  ThreadUpdateData,
} from "@/tools/thread/schema.ts";
import { getOrOpenStream, type ThreadConnection } from "./thread-connection";
import { extractToolErrorMessage } from "./mcp-utils";
import { decopilotSSE } from "@/web/hooks/decopilot-sse-pool";
import type { SSESubscription } from "@/web/hooks/create-sse-subscription";
import type { RowPatch, Task } from "../task/types";
import { Store } from "./store-primitive";

export interface ThreadManagerStoreOptions {
  client?: MCPClient | null;
  /**
   * Override the shared decopilot SSE pool. Tests inject a fake; production
   * code leaves this unset so the singleton in `decopilot-sse-pool.ts` is
   * shared with `useDecopilotEvents`.
   */
  sse?: SSESubscription;
}

export type ThreadsStatus =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; error: Error };

/**
 * How long a just-archived thread id is held in the tombstone set after
 * `hide(id)`. Covers the window where a `decopilot.thread.*` event for the
 * in-flight or already-finished archived run arrives and would otherwise
 * re-insert a synthetic row. 60s is generous enough for slow networks while
 * still letting an un-archive flow recover the row from a fresh event.
 */
const ARCHIVED_TOMBSTONE_TTL_MS = 60_000;

function applyPatch(list: Task[], patch: RowPatch): Task[] {
  const idx = list.findIndex((t) => t.id === patch.id);
  if (idx === -1) {
    const now = new Date().toISOString();
    const synthetic: Task = {
      created_at: patch.created_at ?? patch.updated_at ?? now,
      updated_at: patch.updated_at ?? now,
      ...patch,
      title: patch.title ?? "New chat",
      branch: patch.branch ?? null,
    };
    return [synthetic, ...list];
  }
  const next = [...list];
  next[idx] = { ...next[idx]!, ...patch };
  return next;
}

export class ThreadManagerStore {
  readonly threads = new Store<Task[]>([]);
  readonly threadsStatus = new Store<ThreadsStatus>({ kind: "loading" });
  readonly active = new Store<ThreadConnection | null>(null);
  readonly key: string;
  readonly hasMore = new Store<boolean>(false);
  readonly isFetchingMore = new Store<boolean>(false);

  private pendingOptimistic = new Set<string>();
  /**
   * Short-lived block list of just-archived thread ids. Read by every code
   * path that could re-insert a row (`decopilot.thread.*` patch handler,
   * event buffer drain) and pruned lazily on access. Entries older than
   * ARCHIVED_TOMBSTONE_TTL_MS are dropped.
   */
  private archivedTombstones = new Map<string, number>();
  private client: MCPClient | null;
  private nextOffset = 0;
  private readonly pageSize = 50;
  /**
   * Event buffer: `[]` means "boot, buffering"; `null` means "ready, dispatching live".
   * thread.* events arriving before loadInitialPage resolves are queued here
   * and replayed (tombstone-checked) after the first page lands.
   */
  private eventBuffer: RowPatch[] | null = [];
  private watchUnsubscribe: (() => void) | null = null;

  constructor(
    readonly orgSlug: string,
    readonly locator: string,
    opts: ThreadManagerStoreOptions = {},
  ) {
    this.key = `${orgSlug}::${locator}`;
    this.client = opts.client ?? null;
    const sse = opts.sse ?? decopilotSSE;
    this.watchUnsubscribe = sse.subscribe(
      this.orgSlug,
      (e) => this.handleWatchEvent(e),
      () => this.onWatchReconnect(),
    );
    void this.loadInitialPage();
  }

  dispose(): void {
    this.watchUnsubscribe?.();
    this.watchUnsubscribe = null;
    this.active.set(null);
  }

  setActive(threadId: string): ThreadConnection {
    const conn = getOrOpenStream(this.orgSlug, threadId, {
      client: this.client,
    });
    if (this.active.get() !== conn) this.active.set(conn);
    return conn;
  }

  closeActive(): void {
    // The existing registry only stores one conn — disposing here would
    // re-dispose it elsewhere if the registry already replaced it. We just
    // clear the slot; the registry handles its own lifecycle.
    if (this.active.get() !== null) this.active.set(null);
  }

  async create(data: ThreadCreateData): Promise<Task> {
    try {
      if (!this.client) throw new Error("ThreadManagerStore: no MCP client");
      const result = await this.client.callTool({
        name: "COLLECTION_THREADS_CREATE",
        arguments: { data },
      });
      if ((result as { isError?: boolean }).isError) {
        throw new Error(
          extractToolErrorMessage(result, "COLLECTION_THREADS_CREATE failed"),
        );
      }
      const row = (
        (result as { structuredContent?: unknown }).structuredContent as
          | { item?: Task }
          | undefined
      )?.item;
      if (!row) throw new Error("create: no item returned");
      this.threads.update((list) =>
        list.some((t) => t.id === row.id) ? list : [row, ...list],
      );
      return row;
    } catch (err) {
      // Surface failures here so callers don't each need their own toast.
      // Re-throw so callers can still branch (navigate-anyway, abort, etc.).
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not create thread: ${msg}`);
      throw err;
    }
  }

  rename(id: string, title: string): Promise<void> {
    return this.optimisticUpdate(id, { title });
  }

  hide(id: string): Promise<void> {
    return this.optimisticHide(id);
  }

  setStatus(id: string, status: Task["status"]): Promise<void> {
    return this.optimisticUpdate(id, {
      status: status as ThreadUpdateData["status"],
    });
  }

  setBranch(id: string, branch: string | null): Promise<void> {
    return this.optimisticUpdate(id, { branch });
  }

  /**
   * Local-only patch: apply a partial Task patch in-place. No server round-trip.
   * Used for live signals that don't flow through `/watch` (e.g. titles emitted
   * as `data-thread-title` UIMessageChunks on the per-thread `/stream`).
   *
   * Tombstone-aware: a title update for a just-archived thread is dropped so
   * the synthetic-row upsert in `applyPatch` doesn't resurrect the row.
   */
  patchThread(patch: RowPatch): void {
    if (this.isTombstoned(patch.id)) return;
    this.threads.update((list) => applyPatch(list, patch));
  }

  private async optimisticUpdate(
    id: string,
    patch: ThreadUpdateData,
  ): Promise<void> {
    if (!this.client) throw new Error("ThreadManagerStore: no MCP client");
    const snapshot = this.threads.get();
    this.pendingOptimistic.add(id);
    this.threads.update((list) =>
      applyPatch(list, {
        ...(patch as unknown as RowPatch),
        id,
        updated_at: new Date().toISOString(),
      }),
    );
    try {
      const result = await this.client.callTool({
        name: "COLLECTION_THREADS_UPDATE",
        arguments: { id, data: patch },
      });
      if ((result as { isError?: boolean }).isError) {
        throw new Error("COLLECTION_THREADS_UPDATE failed");
      }
    } catch (err) {
      this.threads.set(snapshot);
      throw err;
    } finally {
      this.pendingOptimistic.delete(id);
    }
  }

  private async optimisticHide(id: string): Promise<void> {
    if (!this.client) throw new Error("ThreadManagerStore: no MCP client");
    const snapshot = this.threads.get();
    this.pendingOptimistic.add(id);
    // Tombstone BEFORE filtering the row out so any late `decopilot.thread.*`
    // event for this thread (e.g., the finish event for a run that was still
    // streaming at archive time) is dropped by handleFrame instead of
    // re-inserting a synthetic row.
    this.archivedTombstones.set(id, Date.now());
    this.threads.update((list) => list.filter((t) => t.id !== id));
    try {
      const result = await this.client.callTool({
        name: "COLLECTION_THREADS_UPDATE",
        arguments: { id, data: { hidden: true } },
      });
      if ((result as { isError?: boolean }).isError) {
        throw new Error("COLLECTION_THREADS_UPDATE failed");
      }
    } catch (err) {
      this.threads.set(snapshot);
      // Server rejected the archive — the row is back in the list, so the
      // tombstone must clear too or future events for that id would be
      // silently dropped.
      this.archivedTombstones.delete(id);
      throw err;
    } finally {
      this.pendingOptimistic.delete(id);
    }
  }

  /** Drop tombstone entries older than the TTL. Called lazily on every read. */
  private pruneArchivedTombstones(): void {
    if (this.archivedTombstones.size === 0) return;
    const cutoff = Date.now() - ARCHIVED_TOMBSTONE_TTL_MS;
    for (const [id, ts] of this.archivedTombstones) {
      if (ts < cutoff) this.archivedTombstones.delete(id);
    }
  }

  private isTombstoned(id: string): boolean {
    this.pruneArchivedTombstones();
    return this.archivedTombstones.has(id);
  }

  private async loadInitialPage(): Promise<void> {
    if (!this.client) {
      // No MCP client — drain the buffer immediately so SSE events are
      // dispatched live (store stays in "loading" status until a client
      // is provided).
      this.drainEventBuffer();
      return;
    }
    try {
      const result = await this.client.callTool({
        name: "COLLECTION_THREADS_LIST",
        arguments: {
          limit: this.pageSize,
          offset: 0,
          orderBy: [{ field: ["updated_at"], direction: "desc" }],
          where: { hidden: false },
        },
      });
      if ((result as { isError?: boolean }).isError) {
        throw new Error(
          extractToolErrorMessage(result, "COLLECTION_THREADS_LIST failed"),
        );
      }
      const payload = ((result as { structuredContent?: unknown })
        .structuredContent ?? result) as { items?: Task[]; hasMore?: boolean };
      const items = payload.items ?? [];
      this.threads.set(items);
      this.hasMore.set(payload.hasMore ?? false);
      this.nextOffset = items.length;
      this.threadsStatus.set({ kind: "ready" });
      this.drainEventBuffer();
    } catch (err) {
      this.threadsStatus.set({
        kind: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  private drainEventBuffer(): void {
    const buffered = this.eventBuffer ?? [];
    this.eventBuffer = null;
    for (const patch of buffered) {
      if (this.isTombstoned(patch.id)) continue;
      this.threads.update((list) => applyPatch(list, patch));
    }
  }

  async fetchNextPage(): Promise<void> {
    if (!this.client) return;
    if (!this.hasMore.get()) return;
    if (this.isFetchingMore.get()) return;
    this.isFetchingMore.set(true);
    try {
      const result = await this.client.callTool({
        name: "COLLECTION_THREADS_LIST",
        arguments: {
          limit: this.pageSize,
          offset: this.nextOffset,
          orderBy: [{ field: ["updated_at"], direction: "desc" }],
          where: { hidden: false },
        },
      });
      if ((result as { isError?: boolean }).isError) {
        throw new Error(
          extractToolErrorMessage(result, "COLLECTION_THREADS_LIST failed"),
        );
      }
      const payload = ((result as { structuredContent?: unknown })
        .structuredContent ?? result) as { items?: Task[]; hasMore?: boolean };
      const items = payload.items ?? [];
      this.threads.update((list) => {
        const seen = new Set(list.map((t) => t.id));
        return [...list, ...items.filter((t) => !seen.has(t.id))];
      });
      this.hasMore.set(payload.hasMore ?? false);
      this.nextOffset += items.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not load more threads: ${msg}`);
    } finally {
      this.isFetchingMore.set(false);
    }
  }

  /**
   * Resolve a thread by id. Checks the loaded `threads` slot first; falls
   * back to a `COLLECTION_THREADS_GET` MCP call when the row isn't in the
   * loaded set (e.g., direct link to an older thread past page 0 or to an
   * archived thread). Returns null if the thread doesn't exist server-side
   * or the MCP call fails.
   *
   * Resolved rows are merged into the local list so subsequent lookups hit
   * the fast path.
   */
  async fetchThread(id: string): Promise<Task | null> {
    if (!id) return null;
    const local = this.threads.get().find((t) => t.id === id);
    if (local) return local;
    if (!this.client) return null;
    try {
      const result = await this.client.callTool({
        name: "COLLECTION_THREADS_GET",
        arguments: { id },
      });
      if ((result as { isError?: boolean }).isError) return null;
      const payload = ((result as { structuredContent?: unknown })
        .structuredContent ?? result) as { item?: Task | null };
      const row = payload.item ?? null;
      if (row) {
        // Merge into the local list so future lookups are local. The row may
        // already be present if a concurrent event arrived between the
        // find() above and this fetch; dedupe by id.
        this.threads.update((list) => {
          if (list.some((t) => t.id === row.id)) return list;
          return [row, ...list];
        });
      }
      return row;
    } catch {
      return null;
    }
  }

  /**
   * Handle a single SSE MessageEvent from the shared decopilot pool. We only
   * care about `decopilot.thread.status` here; other decopilot event types
   * are consumed by `useDecopilotEvents` elsewhere.
   */
  private handleWatchEvent(e: MessageEvent): void {
    if (e.type !== DECOPILOT_EVENTS.THREAD_STATUS) return;
    let parsed: DecopilotThreadStatusEvent;
    try {
      parsed = JSON.parse(e.data) as DecopilotThreadStatusEvent;
    } catch {
      return;
    }
    // Drop events for a thread the user just archived. `applyPatch` has
    // upsert-if-missing semantics, so without this guard a late finish
    // event for a streaming run that was archived mid-flight would
    // re-insert a synthetic row that survives until reload.
    if (this.isTombstoned(parsed.subject)) return;
    const patch: RowPatch = {
      id: parsed.subject,
      updated_at: parsed.data.updated_at ?? parsed.time,
      ...(parsed.data.status !== undefined && {
        status: parsed.data.status,
      }),
      ...(parsed.data.created_by !== undefined && {
        created_by: parsed.data.created_by,
      }),
      ...(parsed.data.trigger_id !== undefined && {
        trigger_id: parsed.data.trigger_id,
      }),
      ...(parsed.data.virtual_mcp_id !== undefined && {
        virtual_mcp_id: parsed.data.virtual_mcp_id,
      }),
      ...(parsed.data.title !== undefined && { title: parsed.data.title }),
      ...(parsed.data.branch !== undefined && {
        branch: parsed.data.branch,
      }),
      ...(parsed.data.created_at !== undefined && {
        created_at: parsed.data.created_at,
      }),
      ...(parsed.data.metadata !== undefined && {
        metadata: parsed.data.metadata as Task["metadata"],
      }),
    };
    if (this.eventBuffer !== null) {
      this.eventBuffer.push(patch);
      return;
    }
    this.threads.update((list) => applyPatch(list, patch));
  }

  /**
   * Fired by the shared SSE pool after the underlying EventSource is
   * re-established post-drop. Re-arm the boot buffer and resync the thread
   * list so any events missed during the disconnect are recovered.
   */
  private onWatchReconnect(): void {
    this.eventBuffer = [];
    void this.loadInitialPage();
  }
}

// ─── Module-scoped registry ──────────────────────────────────────────────────

let current: ThreadManagerStore | null = null;

/** Idempotent: same key → same instance. Different key → dispose + reopen. */
export function getOrOpenManager(
  orgSlug: string,
  locator: string,
  opts: ThreadManagerStoreOptions = {},
): ThreadManagerStore {
  const key = `${orgSlug}::${locator}`;
  if (current && current.key === key) return current;
  current?.dispose();
  current = new ThreadManagerStore(orgSlug, locator, opts);
  return current;
}

/** Look up the active manager by key without forcing a new construction.
 *  Returns null if no manager matches. */
export function getManager(
  orgSlug: string,
  locator: string,
): ThreadManagerStore | null {
  const key = `${orgSlug}::${locator}`;
  return current && current.key === key ? current : null;
}

/** Test-only: dispose the active manager and clear the slot. */
export function __resetManagerRegistry(): void {
  current?.dispose();
  current = null;
}
