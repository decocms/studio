import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import { ThreadManagerStore } from "./thread-manager-store";

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
});

describe("ThreadManagerStore /watch snapshot", () => {
  it("starts in loading state", () => {
    globalThis.fetch = makeSseFetch([]) as unknown as typeof fetch;
    const store = new ThreadManagerStore("acme", "loc-1");
    expect(store.threadsStatus.get()).toEqual({ kind: "loading" });
    expect(store.threads.get()).toEqual([]);
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
      type: "com.deco.decopilot.thread.status",
      subject: "t-1",
      time: "2026-01-02T00:00:00Z",
      data: { status: "in_progress" },
    });
    globalThis.fetch = makeSseFetch([
      `event: snapshot\ndata: ${snapshot}\n\n`,
      `event: com.deco.decopilot.thread.status\ndata: ${ev}\n\n`,
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
      type: "com.deco.decopilot.thread.status",
      subject: "t-new",
      time: "2026-01-02T00:00:00Z",
      data: { status: "in_progress", virtual_mcp_id: "vm-x" },
    });
    globalThis.fetch = makeSseFetch([
      `event: snapshot\ndata: ${snapshot}\n\n`,
      `event: com.deco.decopilot.thread.status\ndata: ${ev}\n\n`,
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
    expect(callTool).toHaveBeenCalledTimes(1);
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
});
