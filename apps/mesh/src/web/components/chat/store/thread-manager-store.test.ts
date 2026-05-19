import { afterEach, describe, expect, it, mock } from "bun:test";
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
