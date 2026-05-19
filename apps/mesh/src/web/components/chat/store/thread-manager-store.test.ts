import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import { __resetRegistry } from "./thread-connection";
import {
  __resetManagerRegistry,
  getManager,
  getOrOpenManager,
  ThreadManagerStore,
} from "./thread-manager-store";

// Fake SSE source. fetch is stubbed to return a controllable ReadableStream
// of SSE chunks.
function makeSseFetch(chunks: string[]) {
  return mock(async (_url: string, _init?: RequestInit) => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  __resetRegistry(); // dispose any ThreadConnection
  __resetManagerRegistry(); // dispose any ThreadManagerStore
});

describe("ThreadManagerStore /watch snapshot", () => {
  it("starts in loading state", () => {
    globalThis.fetch = makeSseFetch([]) as unknown as typeof fetch;
    const store = new ThreadManagerStore("acme", "loc-1");
    expect(store.threadsStatus.get()).toEqual({ kind: "loading" });
    expect(store.threads.get()).toEqual([]);
    store.dispose();
  });

  it("flips status to error on a malformed snapshot frame (and triggers reconnect)", async () => {
    // Two connects: first returns garbage (parse fails → status=error, throw,
    // outer loop reconnects after backoff), second returns a valid snapshot
    // (status=ready).
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      const enc = new TextEncoder();
      const chunks =
        call === 1
          ? [`event: snapshot\ndata: not-json{{{\n\n`]
          : [
              `event: snapshot\ndata: ${JSON.stringify({
                threads: [
                  {
                    id: "t-r",
                    title: "Recovered",
                    updated_at: "2026-01-01T00:00:00Z",
                  },
                ],
              })}\n\n`,
            ];
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          for (const ch of chunks) c.enqueue(enc.encode(ch));
          c.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const store = new ThreadManagerStore("acme", "loc-1");
    // After the first connect, status should land on error (not silently stuck on loading).
    await new Promise((r) => setTimeout(r, 30));
    expect(store.threadsStatus.get().kind).toBe("error");
    // After backoff + reconnect (BASE_DELAY_MS = 1s for attempt=1), the next
    // snapshot recovers. Wait past the 1s backoff.
    await new Promise((r) => setTimeout(r, 1200));
    expect(store.threadsStatus.get()).toEqual({ kind: "ready" });
    expect(store.threads.get().map((t) => t.id)).toEqual(["t-r"]);
    store.dispose();
  });

  it("transitions to ready and populates threads on snapshot event", async () => {
    const snapshot = JSON.stringify({
      threads: [
        { id: "t-1", title: "A", updated_at: "2026-01-01T00:00:00Z" },
        { id: "t-2", title: "B", updated_at: "2026-01-02T00:00:00Z" },
      ],
    });
    globalThis.fetch = makeSseFetch([
      `event: connected\ndata: {"listenerId":"x"}\n\n`,
      `event: snapshot\ndata: ${snapshot}\n\n`,
    ]) as unknown as typeof fetch;

    const store = new ThreadManagerStore("acme", "loc-1");
    // Wait a tick for the SSE consumer to advance.
    await new Promise((r) => setTimeout(r, 10));
    expect(store.threadsStatus.get()).toEqual({ kind: "ready" });
    expect(store.threads.get().map((t) => t.id)).toEqual(["t-1", "t-2"]);
    store.dispose();
  });
});

describe("ThreadManagerStore thread.* event patching", () => {
  it("updates an existing row via thread.status event", async () => {
    const snapshot = JSON.stringify({
      threads: [
        {
          id: "t-1",
          title: "A",
          status: "idle",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const ev = JSON.stringify({
      type: "decopilot.thread.status",
      subject: "t-1",
      time: "2026-01-02T00:00:00Z",
      data: { status: "in_progress" },
    });
    globalThis.fetch = makeSseFetch([
      `event: snapshot\ndata: ${snapshot}\n\n`,
      `event: decopilot.thread.status\ndata: ${ev}\n\n`,
    ]) as unknown as typeof fetch;

    const store = new ThreadManagerStore("acme", "loc-1");
    await new Promise((r) => setTimeout(r, 10));
    expect(store.threads.get()[0]?.status).toBe("in_progress");
    expect(store.threads.get()[0]?.updated_at).toBe("2026-01-02T00:00:00Z");
    store.dispose();
  });

  it("inserts an unknown row at the top from a thread.* event", async () => {
    const snapshot = JSON.stringify({ threads: [] });
    const ev = JSON.stringify({
      type: "decopilot.thread.status",
      subject: "t-new",
      time: "2026-01-02T00:00:00Z",
      data: { status: "in_progress", virtual_mcp_id: "vm-x" },
    });
    globalThis.fetch = makeSseFetch([
      `event: snapshot\ndata: ${snapshot}\n\n`,
      `event: decopilot.thread.status\ndata: ${ev}\n\n`,
    ]) as unknown as typeof fetch;

    const store = new ThreadManagerStore("acme", "loc-1");
    await new Promise((r) => setTimeout(r, 10));
    expect(store.threads.get().map((t) => t.id)).toEqual(["t-new"]);
    store.dispose();
  });
});

describe("ThreadManagerStore optimistic mutators", () => {
  it("rename applies optimistically, calls server, succeeds", async () => {
    const snapshot = JSON.stringify({
      threads: [
        { id: "t-1", title: "Old", updated_at: "2026-01-01T00:00:00Z" },
      ],
    });
    globalThis.fetch = makeSseFetch([
      `event: snapshot\ndata: ${snapshot}\n\n`,
    ]) as unknown as typeof fetch;

    const callTool = mock(async () => ({
      structuredContent: { item: { id: "t-1" } },
    }));
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
    });
    await new Promise((r) => setTimeout(r, 10));

    await store.rename("t-1", "New");
    expect(store.threads.get()[0]?.title).toBe("New");
    // loadInitialPage (COLLECTION_THREADS_LIST) + rename (COLLECTION_THREADS_UPDATE) = 2
    expect(callTool).toHaveBeenCalledTimes(2);
    store.dispose();
  });

  it("rename rolls back on server error", async () => {
    const snapshot = JSON.stringify({
      threads: [
        { id: "t-1", title: "Old", updated_at: "2026-01-01T00:00:00Z" },
      ],
    });
    globalThis.fetch = makeSseFetch([
      `event: snapshot\ndata: ${snapshot}\n\n`,
    ]) as unknown as typeof fetch;

    const callTool = mock(async () => {
      throw new Error("nope");
    });
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
    });
    await new Promise((r) => setTimeout(r, 10));

    await expect(store.rename("t-1", "New")).rejects.toThrow("nope");
    expect(store.threads.get()[0]?.title).toBe("Old");
    store.dispose();
  });

  it("create prepends the row and returns it", async () => {
    globalThis.fetch = makeSseFetch([
      `event: snapshot\ndata: {"threads":[]}\n\n`,
    ]) as unknown as typeof fetch;
    const row = {
      id: "t-new",
      title: "Fresh",
      updated_at: "2026-01-03T00:00:00Z",
    };
    const callTool = mock(async () => ({
      structuredContent: { item: row },
    }));
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
    });
    await new Promise((r) => setTimeout(r, 10));

    const result = await store.create({
      title: "Fresh",
      virtual_mcp_id: "vm-x",
    });
    expect(result.id).toBe("t-new");
    expect(store.threads.get()[0]?.id).toBe("t-new");
  });

  it("create throws with the server error text when result.isError is true", async () => {
    globalThis.fetch = makeSseFetch([
      `event: snapshot\ndata: {"threads":[]}\n\n`,
    ]) as unknown as typeof fetch;
    const callTool = mock(async () => ({
      isError: true,
      content: [{ type: "text", text: "branch already exists" }],
    }));
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
    });
    await new Promise((r) => setTimeout(r, 10));

    await expect(
      store.create({ title: "x", virtual_mcp_id: "vm-x" }),
    ).rejects.toThrow("branch already exists");
    // No row added on failure.
    expect(store.threads.get()).toEqual([]);
    store.dispose();
  });

  it("preserves optimistic rows when a fresh snapshot replaces the list", async () => {
    let resolveSecond: (() => void) | undefined;
    const stalledServer = new Promise<void>((r) => {
      resolveSecond = r;
    });
    const snapshotA = JSON.stringify({
      threads: [
        { id: "t-1", title: "Old", updated_at: "2026-01-01T00:00:00Z" },
      ],
    });
    const snapshotB = JSON.stringify({
      threads: [
        { id: "t-1", title: "ServerOld", updated_at: "2026-01-01T00:00:00Z" },
      ],
    });
    // Controllable SSE source: emit snapshotA immediately, hold snapshotB
    // until we explicitly release it.
    let releaseSnapshotB: (() => void) | undefined;
    const snapshotBGate = new Promise<void>((r) => {
      releaseSnapshotB = r;
    });
    globalThis.fetch = mock(async () => {
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            enc.encode(`event: snapshot\ndata: ${snapshotA}\n\n`),
          );
          await snapshotBGate;
          controller.enqueue(
            enc.encode(`event: snapshot\ndata: ${snapshotB}\n\n`),
          );
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const callTool = mock(async () => {
      await stalledServer;
      return { structuredContent: { item: { id: "t-1" } } };
    });
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
    });
    await new Promise((r) => setTimeout(r, 5));
    // Sanity: first snapshot applied.
    expect(store.threads.get()[0]?.title).toBe("Old");

    // Kick off rename — server is stalled, so `t-1` stays in pendingOptimistic.
    const pending = store.rename("t-1", "New");
    await new Promise((r) => setTimeout(r, 5));
    expect(store.threads.get()[0]?.title).toBe("New");

    // Now release the second snapshot.
    releaseSnapshotB!();
    await new Promise((r) => setTimeout(r, 10));
    // Second snapshot arrived; should NOT overwrite the optimistic title.
    expect(store.threads.get()[0]?.title).toBe("New");

    resolveSecond!();
    await pending;
    store.dispose();
  });
});

describe("ThreadManagerStore archive tombstones", () => {
  it("drops a late decopilot.thread.* event for a just-archived thread", async () => {
    // Two SSE chunks queued: snapshot, then (after hide()) a thread.status
    // event that would normally re-insert a synthetic row via applyPatch.
    let release: ((arg: void) => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const snapshot = JSON.stringify({
      threads: [{ id: "t-1", title: "A", updated_at: "2026-01-01T00:00:00Z" }],
    });
    const lateEvent = JSON.stringify({
      type: "decopilot.thread.status",
      subject: "t-1",
      time: "2026-01-02T00:00:00Z",
      data: { status: "completed" },
    });
    globalThis.fetch = (async () => {
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(enc.encode(`event: snapshot\ndata: ${snapshot}\n\n`));
          await gate;
          c.enqueue(
            enc.encode(
              `event: decopilot.thread.status\ndata: ${lateEvent}\n\n`,
            ),
          );
          c.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const callTool = mock(async () => ({ structuredContent: { item: {} } }));
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
    });
    await new Promise((r) => setTimeout(r, 10));

    // Archive the row.
    await store.hide("t-1");
    expect(store.threads.get()).toEqual([]);

    // Release the late thread.status event.
    release!();
    await new Promise((r) => setTimeout(r, 10));

    // The synthetic row would have been re-inserted without the tombstone.
    expect(store.threads.get()).toEqual([]);
    store.dispose();
  });

  it("drops a stale snapshot row for a just-archived thread", async () => {
    // Two SSE connects. First: snapshot with t-1; user archives it. Second
    // (after reconnect): snapshot that still carries t-1 (server-side hidden
    // flag hasn't propagated yet). The tombstone strips it.
    let call = 0;
    const snapshotWithRow = JSON.stringify({
      threads: [{ id: "t-1", title: "A", updated_at: "2026-01-01T00:00:00Z" }],
    });
    globalThis.fetch = (async () => {
      call++;
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            enc.encode(`event: snapshot\ndata: ${snapshotWithRow}\n\n`),
          );
          c.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const callTool = mock(async () => ({ structuredContent: { item: {} } }));
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(call).toBe(1);

    await store.hide("t-1");
    expect(store.threads.get()).toEqual([]);

    // Wait for the reconnect (BASE_DELAY_MS=1s for clean EOF on attempt=1).
    await new Promise((r) => setTimeout(r, 1200));
    expect(call).toBeGreaterThanOrEqual(2);
    // Stale snapshot would have re-added t-1 without the tombstone.
    expect(store.threads.get()).toEqual([]);
    store.dispose();
  });

  it("clears the tombstone on hide() rollback so future events resume", async () => {
    const snapshot = JSON.stringify({
      threads: [{ id: "t-1", title: "A", updated_at: "2026-01-01T00:00:00Z" }],
    });
    globalThis.fetch = makeSseFetch([
      `event: snapshot\ndata: ${snapshot}\n\n`,
    ]) as unknown as typeof fetch;

    // Server rejects the hide.
    const callTool = mock(async () => {
      throw new Error("server says no");
    });
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
    });
    await new Promise((r) => setTimeout(r, 10));

    await expect(store.hide("t-1")).rejects.toThrow("server says no");
    // Row is restored.
    expect(store.threads.get().map((t) => t.id)).toEqual(["t-1"]);

    // A subsequent local patch should NOT be tombstoned — the rollback
    // cleared the tombstone, so the title update lands.
    store.patchThread({ id: "t-1", title: "Renamed locally" });
    expect(store.threads.get()[0]?.title).toBe("Renamed locally");
    store.dispose();
  });
});

describe("ThreadManagerStore active slot", () => {
  it("setActive opens a connection and exposes it via active store", () => {
    globalThis.fetch = makeSseFetch([
      `event: snapshot\ndata: {"threads":[]}\n\n`,
    ]) as unknown as typeof fetch;
    const store = new ThreadManagerStore("acme", "loc-1");
    const conn = store.setActive("t-1");
    expect(store.active.get()).toBe(conn);
    expect(conn.threadId).toBe("t-1");
    store.dispose();
  });

  it("setActive on a different id swaps the slot", () => {
    globalThis.fetch = makeSseFetch([
      `event: snapshot\ndata: {"threads":[]}\n\n`,
    ]) as unknown as typeof fetch;
    const store = new ThreadManagerStore("acme", "loc-1");
    const a = store.setActive("t-1");
    const b = store.setActive("t-2");
    expect(a).not.toBe(b);
    expect(store.active.get()).toBe(b);
    store.dispose();
  });

  it("closeActive clears the slot", () => {
    globalThis.fetch = makeSseFetch([
      `event: snapshot\ndata: {"threads":[]}\n\n`,
    ]) as unknown as typeof fetch;
    const store = new ThreadManagerStore("acme", "loc-1");
    store.setActive("t-1");
    store.closeActive();
    expect(store.active.get()).toBe(null);
    store.dispose();
  });
});

describe("ThreadManagerStore enriched thread.status events", () => {
  it("synthesizes a row with title/branch from an enriched event (no 'New chat' zombie)", async () => {
    const snapshot = JSON.stringify({ threads: [] });
    const enrichedEvent = JSON.stringify({
      type: "decopilot.thread.status",
      subject: "t-new",
      time: "2026-05-19T00:00:00Z",
      data: {
        status: "in_progress",
        virtual_mcp_id: "vm-x",
        title: "Refactor login",
        branch: "feature/login",
        created_at: "2026-05-19T00:00:00Z",
        updated_at: "2026-05-19T00:00:01Z",
      },
    });
    globalThis.fetch = makeSseFetch([
      `event: snapshot\ndata: ${snapshot}\n\n`,
      `event: decopilot.thread.status\ndata: ${enrichedEvent}\n\n`,
    ]) as unknown as typeof fetch;

    const store = new ThreadManagerStore("acme", "loc-1");
    await new Promise((r) => setTimeout(r, 10));

    const row = store.threads.get()[0];
    expect(row?.id).toBe("t-new");
    expect(row?.title).toBe("Refactor login");
    expect(row?.branch).toBe("feature/login");
    expect(row?.created_at).toBe("2026-05-19T00:00:00Z");
    expect(row?.updated_at).toBe("2026-05-19T00:00:01Z");
    store.dispose();
  });
});

describe("ThreadManagerStore registry", () => {
  it("returns the same instance for same key", () => {
    globalThis.fetch = makeSseFetch([]) as unknown as typeof fetch;
    const a = getOrOpenManager("acme", "loc-1");
    const b = getOrOpenManager("acme", "loc-1");
    expect(a).toBe(b);
  });

  it("disposes and replaces on different key", () => {
    globalThis.fetch = makeSseFetch([]) as unknown as typeof fetch;
    const a = getOrOpenManager("acme", "loc-1");
    const b = getOrOpenManager("acme", "loc-2");
    expect(a).not.toBe(b);
  });

  it("getManager returns null when no manager matches", () => {
    expect(getManager("acme", "loc-1")).toBeNull();
  });
});

describe("ThreadManagerStore pagination via COLLECTION_THREADS_LIST", () => {
  it("loadInitialPage populates threads from MCP and flips status to ready", async () => {
    globalThis.fetch = makeSseFetch([]) as unknown as typeof fetch;
    const callTool = mock(async (args: { name: string }) => {
      if (args.name === "COLLECTION_THREADS_LIST") {
        return {
          structuredContent: {
            items: [
              {
                id: "t-1",
                title: "From MCP",
                updated_at: "2026-05-19T00:00:00Z",
              },
            ],
            hasMore: false,
          },
        };
      }
      return {};
    });
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(store.threadsStatus.get()).toEqual({ kind: "ready" });
    expect(store.threads.get().map((t) => t.id)).toEqual(["t-1"]);
    expect(store.hasMore.get()).toBe(false);
    store.dispose();
  });

  it("loadInitialPage error flips status to error", async () => {
    globalThis.fetch = makeSseFetch([]) as unknown as typeof fetch;
    const callTool = mock(async () => {
      throw new Error("MCP down");
    });
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(store.threadsStatus.get().kind).toBe("error");
    store.dispose();
  });

  it("fetchNextPage appends items and advances offset", async () => {
    globalThis.fetch = makeSseFetch([]) as unknown as typeof fetch;
    let call = 0;
    const callTool = mock(
      async (args: { name: string; arguments: { offset: number } }) => {
        if (args.name !== "COLLECTION_THREADS_LIST") return {};
        call++;
        const offset = args.arguments.offset;
        const items = Array.from({ length: 50 }, (_, i) => ({
          id: `t-${offset + i}`,
          title: `Thread ${offset + i}`,
          updated_at: new Date(2026, 0, offset + i).toISOString(),
        }));
        return {
          structuredContent: { items, hasMore: call < 2 },
        };
      },
    );
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(store.threads.get()).toHaveLength(50);
    expect(store.hasMore.get()).toBe(true);

    await store.fetchNextPage();
    expect(store.threads.get()).toHaveLength(100);
    expect(store.threads.get()[50]?.id).toBe("t-50");
    expect(store.hasMore.get()).toBe(false);
    store.dispose();
  });

  it("fetchNextPage no-ops when !hasMore", async () => {
    globalThis.fetch = makeSseFetch([]) as unknown as typeof fetch;
    let calls = 0;
    const callTool = mock(async () => {
      calls++;
      return {
        structuredContent: { items: [], hasMore: false },
      };
    });
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
    await store.fetchNextPage();
    expect(calls).toBe(1);
    store.dispose();
  });
});

describe("ThreadManagerStore event buffer during boot", () => {
  it("buffers thread.* events until loadInitialPage resolves, then replays", async () => {
    let releaseMcp!: (v: unknown) => void;
    const callTool = mock(
      () =>
        new Promise((r) => {
          releaseMcp = r;
        }),
    );

    // SSE sends an event BEFORE the MCP fetch resolves.
    const enc = new TextEncoder();
    const eventPayload = JSON.stringify({
      type: "decopilot.thread.status",
      subject: "t-event",
      time: "2026-05-19T00:00:00Z",
      data: {
        status: "in_progress",
        title: "From event",
        virtual_mcp_id: "vm-x",
      },
    });
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            enc.encode(
              `event: decopilot.thread.status\ndata: ${eventPayload}\n\n`,
            ),
          );
          c.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
    });
    // Let the SSE event arrive while MCP is stalled.
    await new Promise((r) => setTimeout(r, 20));

    // Event was buffered — not yet applied.
    expect(store.threads.get()).toEqual([]);

    // Release the MCP fetch.
    releaseMcp({
      structuredContent: {
        items: [],
        hasMore: false,
      },
    });
    await new Promise((r) => setTimeout(r, 10));

    // Buffer drained → synthetic row visible with title from the event.
    expect(store.threads.get().map((t) => t.id)).toEqual(["t-event"]);
    expect(store.threads.get()[0]?.title).toBe("From event");
    store.dispose();
  });

  it("tombstones still suppress buffered events for archived threads", async () => {
    let releaseMcp!: (v: unknown) => void;
    const callTool = mock((args: { name: string }) => {
      if (args.name === "COLLECTION_THREADS_LIST") {
        return new Promise((r) => {
          releaseMcp = r;
        });
      }
      // COLLECTION_THREADS_UPDATE for hide
      return Promise.resolve({});
    });

    const enc = new TextEncoder();
    const eventPayload = JSON.stringify({
      type: "decopilot.thread.status",
      subject: "t-archived",
      time: "2026-05-19T00:00:00Z",
      data: { status: "in_progress", title: "Should be dropped" },
    });
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            enc.encode(
              `event: decopilot.thread.status\ndata: ${eventPayload}\n\n`,
            ),
          );
          c.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
    });
    await new Promise((r) => setTimeout(r, 20));

    // Archive the thread BEFORE the MCP fetch resolves — the buffered event
    // will be dropped on drain.
    await store.hide("t-archived");

    releaseMcp({ structuredContent: { items: [], hasMore: false } });
    await new Promise((r) => setTimeout(r, 10));

    // Buffered event dropped by tombstone → row not synthesized.
    expect(store.threads.get()).toEqual([]);
    store.dispose();
  });
});
