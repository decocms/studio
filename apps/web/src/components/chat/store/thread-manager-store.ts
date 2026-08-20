import type { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import { toast } from "sonner";
import { DECOPILOT_EVENTS, type DecopilotThreadStatusEvent } from "@/sdk";
import type {
  ThreadCreateData,
  ThreadUpdateData,
} from "@decocms/shared/thread/schema";
import { getOrOpenStream, type ThreadConnection } from "./thread-connection";
import { isBatchHarness } from "../hosted-runtime-guard";
import { extractToolErrorMessage } from "./mcp-utils";
import { decopilotSSE } from "@/hooks/decopilot-sse-pool";
import type { SSESubscription } from "@/hooks/create-sse-subscription";
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

function applyPatch(
  list: Task[],
  patch: RowPatch,
  /** The insert is a `/watch` synthetic, not an authoritative row. */
  fromWatch = true,
): Task[] {
  const idx = list.findIndex((t) => t.id === patch.id);
  if (idx === -1) {
    const now = new Date().toISOString();
    const inserted: Task = {
      created_at: patch.created_at ?? patch.updated_at ?? now,
      updated_at: patch.updated_at ?? now,
      ...patch,
      title: patch.title ?? "New chat",
      branch: patch.branch ?? null,
      // A `/watch` patch carries no `metadata` — see `Task.partial`. A row from
      // COLLECTION_THREADS_LIST does, so it is NOT partial.
      ...(fromWatch ? { partial: true as const } : {}),
    };
    return [inserted, ...list];
  }
  const next = [...list];
  const current = next[idx]!;
  const currentUpdatedAt = current.updated_at
    ? new Date(current.updated_at).getTime()
    : Number.NEGATIVE_INFINITY;
  const patchUpdatedAt = patch.updated_at
    ? new Date(patch.updated_at).getTime()
    : Number.POSITIVE_INFINITY;
  if (patchUpdatedAt < currentUpdatedAt) return list;
  next[idx] = { ...next[idx]!, ...patch };
  return next;
}

/**
 * Upsert a full, authoritative row: insert if missing, else overwrite fields
 * unconditionally — NO recency guard. Used only by `fetchThreadIntoSlot` for a
 * by-id GET result, which is the source of truth for the rich fields
 * (`harness_id`, `sandbox_provider_kind`, `metadata`) that a concurrent
 * `/watch` synthetic drops. `applyPatch`'s `updated_at` guard would let that
 * newer-but-lossy synthetic win; here the full row always wins. The caller is
 * responsible for the tombstone check.
 */
function upsertFullRow(list: Task[], row: Task): Task[] {
  const idx = list.findIndex((t) => t.id === row.id);
  if (idx === -1) return [row, ...list];
  const next = [...list];
  // An authoritative row clears the partial flag a synthetic may have set.
  next[idx] = { ...next[idx]!, ...row, partial: undefined };
  return next;
}

export class ThreadManagerStore {
  readonly threads = new Store<Task[]>([]);
  readonly threadsStatus = new Store<ThreadsStatus>({ kind: "loading" });
  readonly active = new Store<ThreadConnection | null>(null);
  readonly key: string;
  readonly hasMore = new Store<boolean>(false);
  readonly isFetchingMore = new Store<boolean>(false);

  /**
   * Short-lived block list of just-archived thread ids. Read by every code
   * path that could re-insert a row (`decopilot.thread.*` patch handler,
   * event buffer drain) and pruned lazily on access. Entries older than
   * ARCHIVED_TOMBSTONE_TTL_MS are dropped.
   */
  private archivedTombstones = new Map<string, number>();
  private client: MCPClient | null;
  private nextOffset = 0;
  private readonly pageSize = 10;
  /**
   * Server-side filter fragment merged into `where` for both the initial page
   * and `fetchNextPage`. Defaults to the current user ("me" is resolved
   * server-side) so the sidebar's default "Mine" scope paginates only the
   * user's threads. Without it, "Show more" pages the org-wide feed while the
   * sidebar filters to the user client-side — so a page of teammates' rows is
   * fetched, discarded, and nothing new appears. `setScope` swaps it (`{}` for
   * Team scope). Only the owner scope is pushed here, never the type filter:
   * other readers (org-home, breadcrumb) read this shared store via
   * `findReusableNewChat`, so narrowing by `has_trigger` would hide the user's
   * manual "New chat" and make them mint a duplicate. Widening to Team scope is
   * harmless because those readers re-filter to the user themselves.
   */
  private scopeWhere: Record<string, unknown> = { created_by: "me" };
  private scopeKey = JSON.stringify({ created_by: "me" });
  /**
   * Bumped on every (re)load so a scope switch mid-flight discards the stale
   * response instead of clobbering the newer scope's list.
   */
  private loadGeneration = 0;
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
    // Decide `batch` here too, not just in chat-context: `getOrOpenStream` is
    // idempotent by key, so whichever call lands first fixes the mode for the
    // thread. Reading the row we already hold keeps both callers in agreement.
    const conn = getOrOpenStream(this.orgSlug, threadId, {
      client: this.client,
      batch: isBatchHarness(
        this.threads.get().find((t) => t.id === threadId)?.harness_id,
      ),
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
      toast.error(`Could not create chat: ${msg}`);
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

  /** Re-point an (unsent) thread at a different agent — updates the row's
   * virtual_mcp_id so the sidebar icon follows the selected agent. */
  setAgent(id: string, virtualMcpId: string): Promise<void> {
    return this.optimisticUpdate(id, { virtual_mcp_id: virtualMcpId });
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

  /**
   * Bulk-merge a list of tasks into the flat `threads` slot. Uses the
   * existing `applyPatch` upsert semantics: rows already in the list are
   * updated in-place; new rows are prepended with synthetic-row defaults.
   * Tombstones are honoured so a just-archived thread cannot be resurrected
   * by a per-group "show more" response that still contains the row.
   */
  mergeThreads(items: Task[]): void {
    if (items.length === 0) return;
    this.threads.update((list) =>
      items.reduce((acc, t) => {
        if (this.isTombstoned(t.id)) return acc;
        return applyPatch(acc, t, false);
      }, list),
    );
  }

  private async optimisticUpdate(
    id: string,
    patch: ThreadUpdateData,
  ): Promise<void> {
    if (!this.client) throw new Error("ThreadManagerStore: no MCP client");
    const snapshot = this.threads.get();
    this.threads.update((list) =>
      applyPatch(
        list,
        {
          ...(patch as unknown as RowPatch),
          id,
          updated_at: new Date().toISOString(),
        },
        false,
      ),
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
    }
  }

  private async optimisticHide(id: string): Promise<void> {
    if (!this.client) throw new Error("ThreadManagerStore: no MCP client");
    const snapshot = this.threads.get();
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
    const gen = ++this.loadGeneration;
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
          where: { hidden: false, ...this.scopeWhere },
        },
      });
      if (gen !== this.loadGeneration) return;
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
      if (gen !== this.loadGeneration) return;
      this.threadsStatus.set({
        kind: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
      // A failed page load must not freeze live updates: with the buffer
      // left armed, every later watch event is queued behind a drain that
      // never comes, and the sidebar silently renders the last state it
      // ever knew — a thread stuck on "Done" while its run streams — until
      // a full reload rebuilds the store. One 500 during a listener boot
      // (`COLLECTION_THREADS_LIST` while chat-queue recovery runs) is
      // enough to arm that trap. Draining onto the stale list is strictly
      // better: patches upsert, so rows converge as events arrive.
      this.drainEventBuffer();
    }
  }

  /**
   * Repoint the paginated feed at a new server-side scope (the `where`
   * fragment merged into every list call). No-op if unchanged. Resets
   * pagination and reloads the first page.
   *
   * Safe to call during render: the synchronous body only mutates plain
   * fields and kicks the async reload, which performs no store writes before
   * its first `await`.
   */
  setScope(where: Record<string, unknown>): void {
    const key = JSON.stringify(where);
    if (key === this.scopeKey) return;
    this.scopeKey = key;
    this.scopeWhere = where;
    this.nextOffset = 0;
    void this.loadInitialPage();
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
    const gen = this.loadGeneration;
    try {
      const result = await this.client.callTool({
        name: "COLLECTION_THREADS_LIST",
        arguments: {
          limit: this.pageSize,
          offset: this.nextOffset,
          orderBy: [{ field: ["updated_at"], direction: "desc" }],
          where: { hidden: false, ...this.scopeWhere },
        },
      });
      // A scope switch reset pagination mid-flight — this page is for the old
      // scope, so drop it rather than appending it to the new list.
      if (gen !== this.loadGeneration) return;
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
      toast.error(`Could not load more chats: ${msg}`);
    } finally {
      this.isFetchingMore.set(false);
    }
  }

  /**
   * Resolve a thread by id without mutating the `threads` slot. Checks the
   * loaded set first to skip a round-trip; otherwise issues
   * `COLLECTION_THREADS_GET`. Returns null if the thread doesn't exist
   * server-side or the MCP call fails.
   *
   * The `threads` slot represents threads loaded for the panel (filtered
   * server-side by `hidden: false`); merging arbitrary by-id GET results
   * into it would resurrect archived rows in the panel cache, so this
   * method intentionally returns the row without inserting. Callers that want
   * the resolved thread to also become the slot's source of truth (the active
   * deep-linked view) use `fetchThreadIntoSlot`, which merges non-hidden rows.
   */
  async fetchThread(id: string): Promise<Task | null> {
    if (!id) return null;
    const local = this.threads.get().find((t) => t.id === id);
    if (local) return local;
    return this.getThreadRemote(id);
  }

  /** Server GET for a thread by id, no local short-circuit and no slot write.
   *  Returns null when id is empty, no client, the row is absent server-side,
   *  or the MCP call fails. */
  private async getThreadRemote(id: string): Promise<Task | null> {
    if (!id || !this.client) return null;
    try {
      const result = await this.client.callTool({
        name: "COLLECTION_THREADS_GET",
        arguments: { id },
      });
      if ((result as { isError?: boolean }).isError) return null;
      const payload = ((result as { structuredContent?: unknown })
        .structuredContent ?? result) as { item?: Task | null };
      return payload.item ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Force-refresh a loaded thread's metadata from the server and merge it into
   * the panel slot. Unlike `fetchThread` (which short-circuits on a local hit),
   * this always issues `COLLECTION_THREADS_GET`, so a stale panel row picks up
   * metadata bound after the snapshot — e.g. a teammate's thread whose
   * `githubRepo` / `sandboxMap` was written by `load_repo` after the row was
   * first loaded. A read-only viewer never receives the live `data-open-preview`
   * chunk that patches this client-side, and the thread-status SSE carries no
   * metadata, so without this the preview reads a pre-repo row and shows "no
   * source". Update-only (guards on the row already being present), so it never
   * inserts a teammate's thread into the scoped panel list. Best-effort.
   */
  async refreshThreadMetadata(id: string): Promise<void> {
    if (!id || !this.client) return;
    if (!this.threads.get().some((t) => t.id === id)) return;
    try {
      const result = await this.client.callTool({
        name: "COLLECTION_THREADS_GET",
        arguments: { id },
      });
      if ((result as { isError?: boolean }).isError) return;
      const payload = ((result as { structuredContent?: unknown })
        .structuredContent ?? result) as { item?: Task | null };
      const item = payload.item;
      if (!item) return;
      this.patchThread({
        id: item.id,
        metadata: item.metadata,
        virtual_mcp_id: item.virtual_mcp_id,
        branch: item.branch,
        updated_at: item.updated_at,
      });
    } catch {
      // Best-effort refresh — a failure leaves the (stale) row untouched.
    }
  }

  /**
   * Resolve a thread by id AND, when it's a live (non-hidden) row, merge it into
   * the `threads` slot so the active view (e.g. the CMS preview/blocks editor
   * opened by direct link, whose thread is beyond page 0) shares a single
   * source of truth with the panel. Once merged, optimistic mutations like
   * `setBranch` (the publish branch-hop) patch the row IN-PLACE instead of
   * upserting a lossy synthetic (see `applyPatch`), so `activeTask` actually
   * re-points to the fresh branch.
   *
   * Reads the authoritative row via `getThreadRemote` (NOT `fetchThread`): a
   * local row must not be trusted here, since a concurrent `/watch` event may
   * have already upserted a lossy synthetic (status-only, no `harness_id` /
   * `metadata`) that raced ahead of us. Merged with `upsertFullRow`, NOT
   * `mergeThreads`, so the full row wins over that synthetic even if its
   * `updated_at` is newer (`mergeThreads`'s recency guard would drop it and
   * reintroduce the bug). Tombstone-checked so a just-hidden row can't be
   * resurrected. Falls back to any local row for the return value when the
   * remote read fails, so callers still get something to display.
   *
   * Hidden/archived rows are never merged (preserves the panel's `hidden:false`
   * invariant, see `fetchThread`). Owner-scoping is intentionally NOT applied:
   * the slot is org-wide and every owner-sensitive reader re-filters by
   * `created_by` (`findReusableNewChat`, `readCachedLastThread`, the sidebar's
   * `mineFiltered`).
   */
  async fetchThreadIntoSlot(id: string): Promise<Task | null> {
    const remote = await this.getThreadRemote(id);
    if (remote && !remote.hidden && !this.isTombstoned(remote.id)) {
      this.threads.update((list) => upsertFullRow(list, remote));
    }
    return remote ?? this.threads.get().find((t) => t.id === id) ?? null;
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
      // Carries the batch-vs-streaming decision for the chat connection (see
      // `ThreadConnection.enableBatch`) — a row this store only ever learns
      // about through these events would otherwise stay harness-less until a
      // reload, and its chat would never go live.
      ...(parsed.data.harness_id !== undefined && {
        harness_id: parsed.data.harness_id,
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
