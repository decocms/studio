import type { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  ThreadCreateData,
  ThreadUpdateData,
} from "@/tools/thread/schema.ts";
import { getOrOpenStream, type ThreadConnection } from "./thread-connection";
import type { RowPatch, Task } from "../task/types";
import { Store } from "./store-primitive";

export interface ThreadManagerStoreOptions {
  client?: MCPClient | null;
}

export type ThreadsStatus =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; error: Error };

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

function applyPatch(list: Task[], patch: RowPatch): Task[] {
  const idx = list.findIndex((t) => t.id === patch.id);
  if (idx === -1) {
    const now = patch.updated_at ?? new Date().toISOString();
    const synthetic: Task = {
      created_at: now,
      updated_at: now,
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

  private abort = new AbortController();
  private pendingOptimistic = new Set<string>();
  private client: MCPClient | null;

  constructor(
    readonly orgSlug: string,
    readonly locator: string,
    opts: ThreadManagerStoreOptions = {},
  ) {
    this.key = `${orgSlug}::${locator}`;
    this.client = opts.client ?? null;
    void this.runWatchLoop();
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
    if (!this.client) throw new Error("ThreadManagerStore: no MCP client");
    const result = await this.client.callTool({
      name: "COLLECTION_THREADS_CREATE",
      arguments: { data },
    });
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
   * Used for live signals that don't flow through `/events` (e.g. titles emitted
   * as `data-thread-title` UIMessageChunks on the per-thread `/stream`).
   */
  patchThread(patch: RowPatch): void {
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
      throw err;
    } finally {
      this.pendingOptimistic.delete(id);
    }
  }

  private async runWatchLoop(): Promise<void> {
    const url = `/api/${encodeURIComponent(
      this.orgSlug,
    )}/events?types=decopilot.thread.*`;
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
            error: new Error(`/events ${resp.status}`),
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
    if (event === "snapshot") {
      try {
        const parsed = JSON.parse(data) as { threads: Task[] };
        const pending = this.pendingOptimistic;
        if (pending.size === 0) {
          this.threads.set(parsed.threads);
        } else {
          const current = this.threads.get();
          const optimisticById = new Map(
            current
              .filter((t) => pending.has(t.id))
              .map((t) => [t.id, t] as const),
          );
          this.threads.set(
            parsed.threads.map((t) => optimisticById.get(t.id) ?? t),
          );
          // Optimistic rows that the server hasn't acknowledged yet keep their
          // place by being merged in; an optimistic row absent from the
          // snapshot is preserved at the front.
          const merged = this.threads.get();
          const knownIds = new Set(merged.map((t) => t.id));
          for (const id of pending) {
            if (!knownIds.has(id)) {
              const row = current.find((t) => t.id === id);
              if (row) this.threads.set([row, ...this.threads.get()]);
            }
          }
        }
        this.threadsStatus.set({ kind: "ready" });
      } catch {
        // ignore malformed snapshot
      }
      return;
    }
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
          };
        };
        const patch: RowPatch = {
          id: parsed.subject,
          updated_at: parsed.time,
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
        };
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
