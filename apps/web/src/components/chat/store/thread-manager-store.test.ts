import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import { __resetRegistry } from "./thread-connection";
import {
  __resetManagerRegistry,
  getManager,
  getOrOpenManager,
  ThreadManagerStore,
} from "./thread-manager-store";
import type { SSESubscription } from "@/hooks/create-sse-subscription";
import type { Task } from "../task/types";

/**
 * In-process fake of the decopilot SSE pool used by `ThreadManagerStore`.
 * Tests build one of these and pass it as `opts.sse` so no real EventSource
 * or fetch is opened. Provides imperative helpers for emitting events and
 * simulating the post-drop reconnect that fires `onWatchReconnect`.
 */
interface FakePool extends SSESubscription {
  /** Dispatch a typed SSE event to the subscriber registered for `key`. */
  emit(key: string, type: string, data: unknown): void;
  /** Simulate the shared pool firing onReconnect after a re-establishment. */
  triggerReconnect(key: string): void;
}

function makeFakePool(): FakePool {
  interface Sub {
    handler: (e: MessageEvent) => void;
    onReconnect?: () => void;
  }
  const subs = new Map<string, Sub>();
  return {
    subscribe(key, handler, onReconnect) {
      subs.set(key, { handler, onReconnect });
      return () => {
        const cur = subs.get(key);
        if (cur && cur.handler === handler) subs.delete(key);
      };
    },
    emit(key, type, data) {
      const sub = subs.get(key);
      if (!sub) return;
      const payload = typeof data === "string" ? data : JSON.stringify(data);
      const e = new MessageEvent(type, { data: payload });
      sub.handler(e);
    },
    triggerReconnect(key) {
      subs.get(key)?.onReconnect?.();
    },
  };
}

/**
 * Build a minimal MCP client mock. COLLECTION_THREADS_LIST returns initialItems;
 * all other tools return `{}` (tests that need specific other-tool behavior
 * override callTool themselves).
 */
function makeMcpClient(initialItems: Task[] = []): MCPClient {
  return {
    callTool: mock(async (args: { name: string }) => {
      if (args.name === "COLLECTION_THREADS_LIST") {
        return {
          structuredContent: {
            items: initialItems,
            hasMore: false,
          },
        };
      }
      return {};
    }),
  } as unknown as MCPClient;
}

const threadStatusEvent = (
  subject: string,
  data: Record<string, unknown>,
  time = "2026-01-02T00:00:00Z",
) => ({
  type: "decopilot.thread.status",
  subject,
  time,
  data,
});

afterEach(() => {
  __resetRegistry(); // dispose any ThreadConnection
  __resetManagerRegistry(); // dispose any ThreadManagerStore
});

describe("ThreadManagerStore /watch snapshot", () => {
  it("starts in loading state", () => {
    const sse = makeFakePool();
    const store = new ThreadManagerStore("acme", "loc-1", { sse });
    expect(store.threadsStatus.get()).toEqual({ kind: "loading" });
    expect(store.threads.get()).toEqual([]);
    store.dispose();
  });
});

describe("ThreadManagerStore boot-buffer disarm on load failure", () => {
  /** The freeze this pins: one failed COLLECTION_THREADS_LIST (routine while
   *  the native listener boots) left the boot buffer armed forever, so every
   *  later watch event queued behind a drain that never came — a thread stuck
   *  rendering "Done" while its run streamed, until a full reload. */
  it("a failed initial load still lets later status events through", async () => {
    const sse = makeFakePool();
    const client = {
      callTool: mock(async () => {
        throw new Error("native chat queue recovery failed");
      }),
    } as unknown as MCPClient;
    const store = new ThreadManagerStore("acme", "loc-1", { client, sse });
    await new Promise((r) => setTimeout(r, 10));
    expect(store.threadsStatus.get().kind).toBe("error");

    sse.emit(
      "acme",
      "decopilot.thread.status",
      threadStatusEvent("t-live", { status: "in_progress", title: "Live" }),
    );
    expect(store.threads.get()[0]?.id).toBe("t-live");
    expect(store.threads.get()[0]?.status).toBe("in_progress");
    store.dispose();
  });

  it("a failed post-reconnect resync still lets later status events through", async () => {
    const sse = makeFakePool();
    let listCalls = 0;
    const client = {
      callTool: mock(async (args: { name: string }) => {
        if (args.name !== "COLLECTION_THREADS_LIST") return {};
        listCalls++;
        if (listCalls > 1) throw new Error("listener restarting");
        return {
          structuredContent: {
            items: [
              {
                id: "t-1",
                title: "A",
                status: "completed",
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
              } as Task,
            ],
            hasMore: false,
          },
        };
      }),
    } as unknown as MCPClient;
    const store = new ThreadManagerStore("acme", "loc-1", { client, sse });
    await new Promise((r) => setTimeout(r, 10));
    expect(store.threads.get()[0]?.status).toBe("completed");

    // Reconnect re-arms the buffer and kicks a resync that fails.
    sse.triggerReconnect("acme");
    await new Promise((r) => setTimeout(r, 10));

    sse.emit(
      "acme",
      "decopilot.thread.status",
      threadStatusEvent("t-1", { status: "in_progress" }),
    );
    expect(store.threads.get()[0]?.status).toBe("in_progress");
    store.dispose();
  });
});

describe("ThreadManagerStore thread.* event patching", () => {
  it("updates an existing row via thread.status event", async () => {
    const sse = makeFakePool();
    const client = makeMcpClient([
      {
        id: "t-1",
        title: "A",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      } as Task,
    ]);
    const store = new ThreadManagerStore("acme", "loc-1", { client, sse });
    await new Promise((r) => setTimeout(r, 10));
    sse.emit(
      "acme",
      "decopilot.thread.status",
      threadStatusEvent("t-1", { status: "in_progress" }),
    );
    expect(store.threads.get()[0]?.status).toBe("in_progress");
    expect(store.threads.get()[0]?.updated_at).toBe("2026-01-02T00:00:00Z");
    store.dispose();
  });

  it("does not let an older in_progress event overwrite a locally terminal row", async () => {
    const sse = makeFakePool();
    const client = makeMcpClient([
      {
        id: "t-1",
        title: "A",
        status: "in_progress",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      } as Task,
    ]);
    const store = new ThreadManagerStore("acme", "loc-1", { client, sse });
    await new Promise((r) => setTimeout(r, 10));

    store.patchThread({
      id: "t-1",
      status: "completed",
      updated_at: "2026-01-03T00:00:00Z",
    });

    sse.emit(
      "acme",
      "decopilot.thread.status",
      threadStatusEvent(
        "t-1",
        { status: "in_progress" },
        "2026-01-02T00:00:01Z",
      ),
    );

    expect(store.threads.get()[0]?.status).toBe("completed");
    expect(store.threads.get()[0]?.updated_at).toBe("2026-01-03T00:00:00Z");
    store.dispose();
  });

  it("inserts an unknown row at the top from a thread.* event", async () => {
    const sse = makeFakePool();
    const client = makeMcpClient([]);
    const store = new ThreadManagerStore("acme", "loc-1", { client, sse });
    await new Promise((r) => setTimeout(r, 10));
    sse.emit(
      "acme",
      "decopilot.thread.status",
      threadStatusEvent("t-new", {
        status: "in_progress",
        virtual_mcp_id: "vm-x",
      }),
    );
    expect(store.threads.get().map((t) => t.id)).toEqual(["t-new"]);
    store.dispose();
  });
});

describe("ThreadManagerStore optimistic mutators", () => {
  it("rename applies optimistically, calls server, succeeds", async () => {
    const sse = makeFakePool();
    const callTool = mock(async (args: { name: string }) => {
      if (args.name === "COLLECTION_THREADS_LIST") {
        return {
          structuredContent: {
            items: [
              { id: "t-1", title: "Old", updated_at: "2026-01-01T00:00:00Z" },
            ],
            hasMore: false,
          },
        };
      }
      return { structuredContent: { item: { id: "t-1" } } };
    });
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
      sse,
    });
    await new Promise((r) => setTimeout(r, 10));

    await store.rename("t-1", "New");
    expect(store.threads.get()[0]?.title).toBe("New");
    // loadInitialPage (COLLECTION_THREADS_LIST) + rename (COLLECTION_THREADS_UPDATE) = 2
    expect(callTool).toHaveBeenCalledTimes(2);
    store.dispose();
  });

  it("rename rolls back on server error", async () => {
    const sse = makeFakePool();
    const callTool = mock(async (args: { name: string }) => {
      if (args.name === "COLLECTION_THREADS_LIST") {
        return {
          structuredContent: {
            items: [
              { id: "t-1", title: "Old", updated_at: "2026-01-01T00:00:00Z" },
            ],
            hasMore: false,
          },
        };
      }
      throw new Error("nope");
    });
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
      sse,
    });
    await new Promise((r) => setTimeout(r, 10));

    await expect(store.rename("t-1", "New")).rejects.toThrow("nope");
    expect(store.threads.get()[0]?.title).toBe("Old");
    store.dispose();
  });

  it("create prepends the row and returns it", async () => {
    const sse = makeFakePool();
    const row = {
      id: "t-new",
      title: "Fresh",
      updated_at: "2026-01-03T00:00:00Z",
    };
    const callTool = mock(async (args: { name: string }) => {
      if (args.name === "COLLECTION_THREADS_LIST") {
        return { structuredContent: { items: [], hasMore: false } };
      }
      return { structuredContent: { item: row } };
    });
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
      sse,
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
    const sse = makeFakePool();
    const callTool = mock(async (args: { name: string }) => {
      if (args.name === "COLLECTION_THREADS_LIST") {
        return { structuredContent: { items: [], hasMore: false } };
      }
      return {
        isError: true,
        content: [{ type: "text", text: "branch already exists" }],
      };
    });
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
      sse,
    });
    await new Promise((r) => setTimeout(r, 10));

    await expect(
      store.create({ title: "x", virtual_mcp_id: "vm-x" }),
    ).rejects.toThrow("branch already exists");
    // No row added on failure.
    expect(store.threads.get()).toEqual([]);
    store.dispose();
  });
});

describe("ThreadManagerStore archive tombstones", () => {
  it("drops a late decopilot.thread.* event for a just-archived thread", async () => {
    const sse = makeFakePool();
    const callTool = mock(async (args: { name: string }) => {
      if (args.name === "COLLECTION_THREADS_LIST") {
        return {
          structuredContent: {
            items: [
              { id: "t-1", title: "A", updated_at: "2026-01-01T00:00:00Z" },
            ],
            hasMore: false,
          },
        };
      }
      return { structuredContent: { item: {} } };
    });
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
      sse,
    });
    await new Promise((r) => setTimeout(r, 10));

    // Archive the row.
    await store.hide("t-1");
    expect(store.threads.get()).toEqual([]);

    // Late thread.status event arrives — would normally re-insert via applyPatch.
    sse.emit(
      "acme",
      "decopilot.thread.status",
      threadStatusEvent("t-1", { status: "completed" }),
    );

    // The synthetic row would have been re-inserted without the tombstone.
    expect(store.threads.get()).toEqual([]);
    store.dispose();
  });

  it("clears the tombstone on hide() rollback so future events resume", async () => {
    const sse = makeFakePool();
    // Server rejects the hide.
    const callTool = mock(async (args: { name: string }) => {
      if (args.name === "COLLECTION_THREADS_LIST") {
        return {
          structuredContent: {
            items: [
              { id: "t-1", title: "A", updated_at: "2026-01-01T00:00:00Z" },
            ],
            hasMore: false,
          },
        };
      }
      throw new Error("server says no");
    });
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
      sse,
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
    const sse = makeFakePool();
    const store = new ThreadManagerStore("acme", "loc-1", { sse });
    const conn = store.setActive("t-1");
    expect(store.active.get()).toBe(conn);
    expect(conn.threadId).toBe("t-1");
    store.dispose();
  });

  it("setActive on a different id swaps the slot", () => {
    const sse = makeFakePool();
    const store = new ThreadManagerStore("acme", "loc-1", { sse });
    const a = store.setActive("t-1");
    const b = store.setActive("t-2");
    expect(a).not.toBe(b);
    expect(store.active.get()).toBe(b);
    store.dispose();
  });

  it("closeActive clears the slot", () => {
    const sse = makeFakePool();
    const store = new ThreadManagerStore("acme", "loc-1", { sse });
    store.setActive("t-1");
    store.closeActive();
    expect(store.active.get()).toBe(null);
    store.dispose();
  });
});

describe("ThreadManagerStore enriched thread.status events", () => {
  it("synthesizes a row with title/branch from an enriched event (no 'New chat' zombie)", async () => {
    const sse = makeFakePool();
    const client = makeMcpClient([]);
    const store = new ThreadManagerStore("acme", "loc-1", { client, sse });
    await new Promise((r) => setTimeout(r, 10));

    sse.emit(
      "acme",
      "decopilot.thread.status",
      threadStatusEvent(
        "t-new",
        {
          status: "in_progress",
          virtual_mcp_id: "vm-x",
          title: "Refactor login",
          branch: "feature/login",
          created_at: "2026-05-19T00:00:00Z",
          updated_at: "2026-05-19T00:00:01Z",
          routing_locked_at: "2026-05-19T00:00:00Z",
          hosted_execution_disabled_at: null,
          harness_id: "decopilot",
          sandbox_provider_kind: "agent-sandbox",
        },
        "2026-05-19T00:00:00Z",
      ),
    );

    const row = store.threads.get()[0];
    expect(row?.id).toBe("t-new");
    expect(row?.title).toBe("Refactor login");
    expect(row?.branch).toBe("feature/login");
    expect(row?.created_at).toBe("2026-05-19T00:00:00Z");
    expect(row?.updated_at).toBe("2026-05-19T00:00:01Z");
    expect(row?.routing_locked_at).toBe("2026-05-19T00:00:00Z");
    expect(row?.hosted_execution_disabled_at).toBeNull();
    expect(row?.harness_id).toBe("decopilot");
    expect(row?.sandbox_provider_kind).toBe("agent-sandbox");
    store.dispose();
  });

  it("preserves explicit nulls that clear stale authority and compatibility fields", async () => {
    const sse = makeFakePool();
    const client = makeMcpClient([
      {
        id: "t-existing",
        title: "Existing",
        created_at: "2026-05-19T00:00:00Z",
        updated_at: "2026-05-19T00:00:00Z",
        routing_locked_at: "2026-05-19T00:00:00Z",
        hosted_execution_disabled_at: "2026-05-19T00:00:00Z",
        harness_id: "claude-code",
        sandbox_provider_kind: "user-desktop",
      },
    ]);
    const store = new ThreadManagerStore("acme", "loc-1", { client, sse });
    await new Promise((r) => setTimeout(r, 10));

    sse.emit(
      "acme",
      "decopilot.thread.status",
      threadStatusEvent("t-existing", {
        status: "completed",
        updated_at: "2026-05-19T00:00:01Z",
        routing_locked_at: null,
        hosted_execution_disabled_at: null,
        harness_id: null,
        sandbox_provider_kind: null,
      }),
    );

    const row = store.threads.get()[0];
    expect(row?.routing_locked_at).toBeNull();
    expect(row?.hosted_execution_disabled_at).toBeNull();
    expect(row?.harness_id).toBeNull();
    expect(row?.sandbox_provider_kind).toBeNull();
    store.dispose();
  });
});

describe("ThreadManagerStore.fetchThread", () => {
  it("returns the local row when present", async () => {
    const sse = makeFakePool();
    const callTool = mock(async (args: { name: string }) => {
      if (args.name === "COLLECTION_THREADS_LIST") {
        return {
          structuredContent: {
            items: [{ id: "t-1", updated_at: "2026-05-19T00:00:00Z" }],
            hasMore: false,
          },
        };
      }
      return {};
    });
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
      sse,
    });
    await new Promise((r) => setTimeout(r, 10));

    const row = await store.fetchThread("t-1");
    expect(row?.id).toBe("t-1");
    // Did not call THREADS_GET — local hit.
    const getCalls = callTool.mock.calls.filter(
      (c) => (c[0] as { name: string }).name === "COLLECTION_THREADS_GET",
    );
    expect(getCalls.length).toBe(0);
    store.dispose();
  });

  it("falls back to COLLECTION_THREADS_GET when absent locally", async () => {
    const sse = makeFakePool();
    const callTool = mock(
      async (args: { name: string; arguments: unknown }) => {
        if (args.name === "COLLECTION_THREADS_LIST") {
          return { structuredContent: { items: [], hasMore: false } };
        }
        if (args.name === "COLLECTION_THREADS_GET") {
          return {
            structuredContent: {
              item: {
                id: "t-archived",
                title: "Old thread",
                hidden: true,
                updated_at: "2026-05-19T00:00:00Z",
              },
            },
          };
        }
        return {};
      },
    );
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
      sse,
    });
    await new Promise((r) => setTimeout(r, 10));

    const row = await store.fetchThread("t-archived");
    expect(row?.id).toBe("t-archived");
    expect(row?.title).toBe("Old thread");
    // fetchThread is a pure read: the row is returned to the caller but
    // NOT inserted into the panel-visible threads slot. Otherwise an
    // archived row (or an in-flight just-hidden row, before its UPDATE
    // commits server-side) could resurrect itself in the panel cache.
    expect(store.threads.get().some((t) => t.id === "t-archived")).toBe(false);
    store.dispose();
  });

  it("returns null when the row doesn't exist", async () => {
    const sse = makeFakePool();
    const callTool = mock(async (args: { name: string }) => {
      if (args.name === "COLLECTION_THREADS_LIST") {
        return { structuredContent: { items: [], hasMore: false } };
      }
      if (args.name === "COLLECTION_THREADS_GET") {
        return { structuredContent: { item: null } };
      }
      return {};
    });
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
      sse,
    });
    await new Promise((r) => setTimeout(r, 10));

    const row = await store.fetchThread("nope");
    expect(row).toBeNull();
    store.dispose();
  });
});

describe("ThreadManagerStore registry", () => {
  it("returns the same instance for same key", () => {
    const sse = makeFakePool();
    const a = getOrOpenManager("acme", "loc-1", { sse });
    const b = getOrOpenManager("acme", "loc-1", { sse });
    expect(a).toBe(b);
  });

  it("disposes and replaces on different key", () => {
    const sse = makeFakePool();
    const a = getOrOpenManager("acme", "loc-1", { sse });
    const b = getOrOpenManager("acme", "loc-2", { sse });
    expect(a).not.toBe(b);
  });

  it("getManager returns null when no manager matches", () => {
    expect(getManager("acme", "loc-1")).toBeNull();
  });
});

describe("ThreadManagerStore pagination via COLLECTION_THREADS_LIST", () => {
  it("loadInitialPage populates threads from MCP and flips status to ready", async () => {
    const sse = makeFakePool();
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
      sse,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(store.threadsStatus.get()).toEqual({ kind: "ready" });
    expect(store.threads.get().map((t) => t.id)).toEqual(["t-1"]);
    expect(store.hasMore.get()).toBe(false);
    store.dispose();
  });

  it("loadInitialPage error flips status to error", async () => {
    const sse = makeFakePool();
    const callTool = mock(async () => {
      throw new Error("MCP down");
    });
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
      sse,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(store.threadsStatus.get().kind).toBe("error");
    store.dispose();
  });

  it("fetchNextPage appends items and advances offset", async () => {
    const sse = makeFakePool();
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
      sse,
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
    const sse = makeFakePool();
    let calls = 0;
    const callTool = mock(async () => {
      calls++;
      return {
        structuredContent: { items: [], hasMore: false },
      };
    });
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
      sse,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
    await store.fetchNextPage();
    expect(calls).toBe(1);
    store.dispose();
  });

  it("fetchNextPage no-ops while already in flight", async () => {
    const sse = makeFakePool();
    let releaseSecond!: (v: unknown) => void;
    let calls = 0;
    const callTool = mock(async (args: { name: string }) => {
      if (args.name !== "COLLECTION_THREADS_LIST") return {};
      calls++;
      if (calls === 1) {
        // initial page resolves
        return {
          structuredContent: {
            items: [{ id: "t-0", updated_at: "2026-01-01T00:00:00Z" }],
            hasMore: true,
          },
        };
      }
      return new Promise((r) => {
        releaseSecond = r;
      });
    });
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
      sse,
    });
    await new Promise((r) => setTimeout(r, 10));

    const p1 = store.fetchNextPage();
    const p2 = store.fetchNextPage(); // should no-op
    expect(store.isFetchingMore.get()).toBe(true);
    releaseSecond({ structuredContent: { items: [], hasMore: false } });
    await Promise.all([p1, p2]);
    expect(store.isFetchingMore.get()).toBe(false);
    expect(calls).toBe(2); // initial + first fetchNextPage; second fetchNextPage was a no-op
    store.dispose();
  });

  it("re-runs loadInitialPage on /watch reconnect (resync after disconnect)", async () => {
    const sse = makeFakePool();
    let mcpCalls = 0;
    const callTool = mock(async (args: { name: string }) => {
      if (args.name !== "COLLECTION_THREADS_LIST") return {};
      mcpCalls++;
      return {
        structuredContent: {
          items:
            mcpCalls === 1
              ? [{ id: "t-initial", updated_at: "2026-05-19T00:00:00Z" }]
              : [
                  {
                    id: "t-after-reconnect",
                    updated_at: "2026-05-19T00:01:00Z",
                  },
                ],
          hasMore: false,
        },
      };
    });
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
      sse,
    });
    // Wait for initial connect + load
    await new Promise((r) => setTimeout(r, 10));
    expect(store.threads.get().map((t) => t.id)).toEqual(["t-initial"]);
    expect(mcpCalls).toBe(1);

    // Pool tells us the EventSource was re-established post-drop. The store
    // should re-arm the buffer and re-load the initial page.
    sse.triggerReconnect("acme");
    await new Promise((r) => setTimeout(r, 10));

    expect(mcpCalls).toBe(2);
    expect(store.threads.get().map((t) => t.id)).toEqual(["t-after-reconnect"]);
    store.dispose();
  });

  it("scopes the list to created_by: 'me' by default", async () => {
    const sse = makeFakePool();
    const wheres: unknown[] = [];
    const callTool = mock(
      async (args: { name: string; arguments: { where: unknown } }) => {
        if (args.name !== "COLLECTION_THREADS_LIST") return {};
        wheres.push(args.arguments.where);
        return { structuredContent: { items: [], hasMore: false } };
      },
    );
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
      sse,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(wheres[0]).toEqual({ hidden: false, created_by: "me" });
    store.dispose();
  });

  it("setScope reloads page 1 with the new where and resets offset", async () => {
    const sse = makeFakePool();
    const wheres: Record<string, unknown>[] = [];
    let call = 0;
    const callTool = mock(
      async (args: {
        name: string;
        arguments: { where: Record<string, unknown>; offset: number };
      }) => {
        if (args.name !== "COLLECTION_THREADS_LIST") return {};
        call++;
        wheres.push(args.arguments.where);
        return {
          structuredContent: {
            items: [
              { id: `scope-${call}`, updated_at: "2026-05-19T00:00:00Z" },
            ],
            hasMore: false,
          },
        };
      },
    );
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
      sse,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(wheres[0]).toEqual({ hidden: false, created_by: "me" });

    // Widen to Team scope (org-wide).
    store.setScope({});
    await new Promise((r) => setTimeout(r, 10));
    expect(wheres[1]).toEqual({ hidden: false });
    expect(store.threads.get().map((t) => t.id)).toEqual(["scope-2"]);

    // Unchanged scope is a no-op (no extra fetch).
    const before = call;
    store.setScope({});
    await new Promise((r) => setTimeout(r, 10));
    expect(call).toBe(before);
    store.dispose();
  });
});

describe("ThreadManagerStore event buffer during boot", () => {
  it("buffers thread.* events until loadInitialPage resolves, then replays", async () => {
    const sse = makeFakePool();
    let releaseMcp!: (v: unknown) => void;
    const callTool = mock(
      () =>
        new Promise((r) => {
          releaseMcp = r;
        }),
    );

    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
      sse,
    });
    // Let the store register its handler.
    await new Promise((r) => setTimeout(r, 5));

    // Emit a thread event BEFORE the MCP fetch resolves — should be buffered.
    sse.emit(
      "acme",
      "decopilot.thread.status",
      threadStatusEvent(
        "t-event",
        {
          status: "in_progress",
          title: "From event",
          virtual_mcp_id: "vm-x",
        },
        "2026-05-19T00:00:00Z",
      ),
    );

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
    const sse = makeFakePool();
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

    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
      sse,
    });
    await new Promise((r) => setTimeout(r, 5));

    // SSE event arrives while MCP is stalled.
    sse.emit(
      "acme",
      "decopilot.thread.status",
      threadStatusEvent(
        "t-archived",
        { status: "in_progress", title: "Should be dropped" },
        "2026-05-19T00:00:00Z",
      ),
    );

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

describe("ThreadManagerStore.mergeThreads", () => {
  afterEach(() => {
    __resetManagerRegistry();
    __resetRegistry();
  });

  it("appends new tasks and dedupes by id", async () => {
    const sse = makeFakePool();
    const client = makeMcpClient([
      {
        id: "a",
        title: "A",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ]);
    const store = new ThreadManagerStore("org", "loc", { client, sse });
    // Wait for the initial page to land.
    await new Promise((r) => setTimeout(r, 0));

    store.mergeThreads([
      {
        id: "a",
        title: "A (updated)",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      },
      {
        id: "b",
        title: "B",
        created_at: "2026-01-03T00:00:00Z",
        updated_at: "2026-01-03T00:00:00Z",
      },
    ]);

    const list = store.threads.get();
    expect(list.map((t) => t.id).sort()).toEqual(["a", "b"]);
    expect(list.find((t) => t.id === "a")?.title).toBe("A (updated)");
  });

  it("is a no-op for an empty batch", async () => {
    const sse = makeFakePool();
    const client = makeMcpClient([
      {
        id: "a",
        title: "A",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ]);
    const store = new ThreadManagerStore("org", "loc", { client, sse });
    await new Promise((r) => setTimeout(r, 0));

    const before = store.threads.get();
    store.mergeThreads([]);
    expect(store.threads.get()).toBe(before);
  });

  it("drops items whose id is tombstoned", async () => {
    const sse = makeFakePool();
    const client = makeMcpClient([
      {
        id: "t-1",
        title: "A",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      } as Task,
    ]);
    const store = new ThreadManagerStore("org", "loc", { client, sse });
    // Wait for loadInitialPage to complete and store to reach ready state.
    await new Promise((r) => setTimeout(r, 10));
    expect(store.threadsStatus.get()).toEqual({ kind: "ready" });

    // Tombstone the row via hide() (optimistic update removes it immediately).
    await store.hide("t-1");
    expect(store.threads.get()).toEqual([]);

    // Simulate a "show more" response that still contains the just-archived row.
    store.mergeThreads([
      {
        id: "t-1",
        title: "A",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      } as Task,
    ]);

    // The tombstoned row must remain absent.
    expect(store.threads.get()).toEqual([]);
    store.dispose();
  });
});

// Regression: the CMS preview/blocks editor is reached by direct link, so its
// thread is fetched by-id and merged into the slot (see `useEnsureTask`). A
// branch hop on publish (`setBranch`) must patch that row IN-PLACE — preserving
// routing authority / metadata — so the active-task branch actually flips and
// the view re-points to the fresh branch. Before the merge fix, `setBranch` on
// a row absent from the slot upserted a LOSSY synthetic row instead, corrupting
// the active task and stranding the user on the just-published branch.
describe("ThreadManagerStore.setBranch on a deep-linked (by-id) thread", () => {
  afterEach(() => {
    __resetManagerRegistry();
    __resetRegistry();
  });

  const richThread = {
    id: "t-cms",
    title: "CMS session",
    branch: "old-branch",
    routing_locked_at: "2026-08-04T00:00:00.000Z",
    hosted_execution_disabled_at: "2026-08-04T00:01:00.000Z",
    harness_id: "harness-x",
    sandbox_provider_kind: "user-desktop",
    metadata: { sandboxMap: { u1: { "old-branch": {} } } },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  } as unknown as Task;

  it("patches the merged row in-place, preserving routing authority and metadata", async () => {
    const sse = makeFakePool();
    const client = makeMcpClient([]);
    const store = new ThreadManagerStore("org", "loc", { client, sse });
    await new Promise((r) => setTimeout(r, 0));

    // useEnsureTask merges the by-id row into the slot (it isn't hidden).
    store.mergeThreads([richThread]);

    await store.setBranch("t-cms", "fresh-branch");

    const row = store.threads.get().find((t) => t.id === "t-cms");
    expect(row?.branch).toBe("fresh-branch");
    // The full fields survive — the update is not the lossy synthetic path.
    expect(row?.routing_locked_at).toBe("2026-08-04T00:00:00.000Z");
    expect(row?.hosted_execution_disabled_at).toBe("2026-08-04T00:01:00.000Z");
    expect(row?.harness_id).toBe("harness-x");
    expect(row?.metadata).toEqual({ sandboxMap: { u1: { "old-branch": {} } } });
    store.dispose();
  });

  it("upserts a LOSSY synthetic when the row was never merged (the pre-fix bug)", async () => {
    const sse = makeFakePool();
    const client = makeMcpClient([]);
    const store = new ThreadManagerStore("org", "loc", { client, sse });
    await new Promise((r) => setTimeout(r, 0));

    // No merge: mirrors the old behavior where the by-id row stayed out of the
    // slot, so setBranch has nothing to patch and fabricates a bare row.
    await store.setBranch("t-cms", "fresh-branch");

    const row = store.threads.get().find((t) => t.id === "t-cms");
    expect(row?.branch).toBe("fresh-branch");
    // Routing authority / metadata are gone — this is exactly why the active
    // task (which reads these) breaks without the merge fix.
    expect(row?.routing_locked_at).toBeUndefined();
    expect(row?.harness_id).toBeUndefined();
    expect(row?.metadata).toBeUndefined();
    store.dispose();
  });
});

// `fetchThreadIntoSlot` is the actual fix seam (called by `useEnsureTask`): it
// resolves a thread by id and merges LIVE rows into the slot so the deep-linked
// active view shares one source of truth with the panel. These tests guard the
// `!hidden` decision and the win-over-lossy-synthetic race directly.
describe("ThreadManagerStore.fetchThreadIntoSlot", () => {
  afterEach(() => {
    __resetManagerRegistry();
    __resetRegistry();
  });

  const richThread = {
    id: "t-cms",
    title: "CMS session",
    branch: "old-branch",
    routing_locked_at: "2026-08-04T00:00:00.000Z",
    hosted_execution_disabled_at: "2026-08-04T00:01:00.000Z",
    harness_id: "harness-x",
    sandbox_provider_kind: "user-desktop",
    metadata: { sandboxMap: { u1: { "old-branch": {} } } },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  } as unknown as Task;

  function makeGetClient(item: Task | null): MCPClient {
    return {
      callTool: mock(async (args: { name: string }) => {
        if (args.name === "COLLECTION_THREADS_LIST") {
          return { structuredContent: { items: [], hasMore: false } };
        }
        if (args.name === "COLLECTION_THREADS_GET") {
          return { structuredContent: { item } };
        }
        return {};
      }),
    } as unknown as MCPClient;
  }

  it("merges a non-hidden by-id row into the slot", async () => {
    const sse = makeFakePool();
    const store = new ThreadManagerStore("org", "loc", {
      client: makeGetClient(richThread),
      sse,
    });
    await new Promise((r) => setTimeout(r, 10));

    const returned = await store.fetchThreadIntoSlot("t-cms");
    expect(returned?.id).toBe("t-cms");
    const row = store.threads.get().find((t) => t.id === "t-cms");
    expect(row?.routing_locked_at).toBe("2026-08-04T00:00:00.000Z");
    expect(row?.hosted_execution_disabled_at).toBe("2026-08-04T00:01:00.000Z");
    expect(row?.harness_id).toBe("harness-x");
    store.dispose();
  });

  it("does NOT merge a hidden (archived) by-id row — panel invariant", async () => {
    const sse = makeFakePool();
    const store = new ThreadManagerStore("org", "loc", {
      client: makeGetClient({ ...richThread, hidden: true } as Task),
      sse,
    });
    await new Promise((r) => setTimeout(r, 10));

    const returned = await store.fetchThreadIntoSlot("t-cms");
    // The caller still gets the row (for display), but the panel slot stays clean.
    expect(returned?.hidden).toBe(true);
    expect(store.threads.get().some((t) => t.id === "t-cms")).toBe(false);
    store.dispose();
  });

  it("wins over a lossy synthetic already in the slot (the /watch race)", async () => {
    const sse = makeFakePool();
    const store = new ThreadManagerStore("org", "loc", {
      client: makeGetClient(richThread),
      sse,
    });
    await new Promise((r) => setTimeout(r, 10));

    // Simulate a concurrent /watch event landing FIRST: a status-only synthetic
    // with a NEWER updated_at and none of the rich fields.
    store.mergeThreads([
      {
        id: "t-cms",
        title: "New chat",
        branch: "old-branch",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2099-01-01T00:00:00Z",
      } as Task,
    ]);
    expect(
      store.threads.get().find((t) => t.id === "t-cms")?.routing_locked_at,
    ).toBeUndefined();

    // The authoritative full row must win despite its OLDER updated_at, so the
    // active task regains routing authority/metadata (otherwise the bug reappears).
    await store.fetchThreadIntoSlot("t-cms");
    const row = store.threads.get().find((t) => t.id === "t-cms");
    expect(row?.routing_locked_at).toBe("2026-08-04T00:00:00.000Z");
    expect(row?.hosted_execution_disabled_at).toBe("2026-08-04T00:01:00.000Z");
    expect(row?.harness_id).toBe("harness-x");
    expect(row?.metadata).toEqual({ sandboxMap: { u1: { "old-branch": {} } } });
    store.dispose();
  });
});
