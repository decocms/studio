import type { RowPatch, Task } from "../task/types";
import { Store } from "./store-primitive";

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

  private abort = new AbortController();

  constructor(
    readonly orgSlug: string,
    readonly locator: string,
  ) {
    void this.runWatchLoop();
  }

  dispose(): void {
    this.abort.abort();
  }

  private async runWatchLoop(): Promise<void> {
    const url = `/api/${encodeURIComponent(
      this.orgSlug,
    )}/events?types=com.deco.decopilot.thread.*`;
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
        this.threads.set(parsed.threads);
        this.threadsStatus.set({ kind: "ready" });
      } catch {
        // ignore malformed snapshot
      }
      return;
    }
    if (event.startsWith("com.deco.decopilot.thread.")) {
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
