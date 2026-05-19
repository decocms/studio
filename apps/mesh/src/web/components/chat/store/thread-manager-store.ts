import type { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import { toast } from "sonner";
import type {
  ThreadCreateData,
  ThreadUpdateData,
} from "@/tools/thread/schema.ts";
import { getOrOpenStream, type ThreadConnection } from "./thread-connection";
import type { RowPatch, Task } from "../task/types";
import { Store } from "./store-primitive";

/**
 * Extract a server-side error message from a `callTool` result, falling back
 * to the supplied default when no usable text is present. Mirrors the shape
 * the MCP SDK returns for tool failures: `{ isError: true, content: [{ text }] }`.
 */
function extractToolErrorMessage(result: unknown, fallback: string): string {
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const first = content[0];
    if (first && typeof first === "object") {
      const text = (first as { text?: string }).text;
      if (text) return text;
    }
  }
  return fallback;
}

export interface ThreadManagerStoreOptions {
  client?: MCPClient | null;
}

export type ThreadsStatus =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; error: Error };

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

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

  private abort = new AbortController();
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

  constructor(
    readonly orgSlug: string,
    readonly locator: string,
    opts: ThreadManagerStoreOptions = {},
  ) {
    this.key = `${orgSlug}::${locator}`;
    this.client = opts.client ?? null;
    void this.runWatchLoop();
    void this.loadInitialPage();
  }

  dispose(): void {
    this.abort.abort();
    this.active.set(null);
  }

  setActive(threadId: string): ThreadConnection {
    const conn = getOrOpenStream(this.orgSlug, threadId);
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

  private async runWatchLoop(): Promise<void> {
    const url = `/api/${encodeURIComponent(
      this.orgSlug,
    )}/watch?types=decopilot.thread.*`;
    let attempt = 0;

    while (!this.abort.signal.aborted) {
      try {
        const resp = await fetch(url, {
          method: "GET",
          credentials: "include",
          headers: { accept: "text/event-stream" },
          signal: this.abort.signal,
        });
        if (!resp.ok || !resp.body) {
          this.threadsStatus.set({
            kind: "error",
            error: new Error(`/watch ${resp.status}`),
          });
        } else {
          attempt = 0;
          await this.consumeSse(resp.body);
        }
      } catch (err) {
        if (this.abort.signal.aborted) return;
        // Transient — fall through to backoff.
        void err;
      }
      if (this.abort.signal.aborted) return;
      const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
      attempt++;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delay);
        this.abort.signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  private async consumeSse(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        this.handleFrame(frame);
      }
    }
  }

  private handleFrame(frame: string): void {
    const lines = frame.split("\n");
    let event = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    if (event.startsWith("decopilot.thread.")) {
      try {
        const parsed = JSON.parse(data) as {
          subject: string;
          time?: string;
          data: {
            status?: Task["status"];
            created_by?: string;
            trigger_id?: string;
            virtual_mcp_id?: string;
            title?: string;
            branch?: string | null;
            created_at?: string;
            updated_at?: string;
          };
        };
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
        };
        if (this.eventBuffer !== null) {
          this.eventBuffer.push(patch);
          return;
        }
        this.threads.update((list) => applyPatch(list, patch));
      } catch {
        // ignore malformed
      }
    }
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
