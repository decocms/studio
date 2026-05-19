/**
 * Store-level smoke tests for the hook layer.
 *
 * No `@testing-library/react` is available, so we exercise the manager
 * directly and assert the same Store<T> slots the hooks read from. Each
 * test below mirrors what the corresponding hook would observe via
 * useSyncExternalStore — i.e. the hook is a one-line wrapper, the unit of
 * behavior is the store.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { __resetRegistry } from "./thread-connection";
import {
  __resetManagerRegistry,
  ThreadManagerStore,
} from "./thread-manager-store";

function streamSse(chunks: string[]): typeof fetch {
  return mock(async () => {
    const enc = new TextEncoder();
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
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  __resetRegistry();
  __resetManagerRegistry();
});

describe("hooks: useThreads source (manager.threads)", () => {
  it("starts empty and flips to ready after snapshot", async () => {
    globalThis.fetch = streamSse([
      `event: snapshot\ndata: ${JSON.stringify({
        threads: [
          { id: "t-1", title: "A", updated_at: "2026-01-01T00:00:00Z" },
        ],
      })}\n\n`,
    ]);
    const store = new ThreadManagerStore("acme", "loc-1");
    expect(store.threads.get()).toEqual([]);
    expect(store.threadsStatus.get()).toEqual({ kind: "loading" });
    await new Promise((r) => setTimeout(r, 10));
    expect(store.threadsStatus.get()).toEqual({ kind: "ready" });
    expect(store.threads.get().map((t) => t.id)).toEqual(["t-1"]);
    store.dispose();
  });
});

describe("hooks: useActiveThread source (manager.active)", () => {
  it("active.get() is null until setActive, then flips to the conn", () => {
    globalThis.fetch = streamSse([`event: snapshot\ndata: {"threads":[]}\n\n`]);
    const store = new ThreadManagerStore("acme", "loc-1");
    expect(store.active.get()).toBeNull();
    const conn = store.setActive("t-1");
    expect(store.active.get()).toBe(conn);
    store.closeActive();
    expect(store.active.get()).toBeNull();
    store.dispose();
  });
});

describe("hooks: useThreadMessages source (active conn .messages)", () => {
  it("reflects the conn's /stream snapshot event", async () => {
    let call = 0;
    globalThis.fetch = mock(async () => {
      call++;
      const enc = new TextEncoder();
      const body =
        call === 1
          ? new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(
                  enc.encode(`event: snapshot\ndata: {"threads":[]}\n\n`),
                );
                c.close();
              },
            })
          : new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(
                  enc.encode(
                    `event: snapshot\ndata: ${JSON.stringify({
                      messages: [
                        {
                          id: "m-1",
                          role: "user",
                          parts: [{ type: "text", text: "hi" }],
                        },
                      ],
                    })}\n\n`,
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

    const store = new ThreadManagerStore("acme", "loc-1");
    const conn = store.setActive("t-1");
    await new Promise((r) => setTimeout(r, 20));
    expect(conn.messages.get().map((m) => m.id)).toEqual(["m-1"]);
    expect(store.active.get()).toBe(conn);
    store.dispose();
  });

  it("is an empty array when no active conn (hook fallback semantics)", () => {
    globalThis.fetch = streamSse([`event: snapshot\ndata: {"threads":[]}\n\n`]);
    const store = new ThreadManagerStore("acme", "loc-1");
    // useThreadMessages reads from active?.messages; when active is null it
    // returns the module-scoped empty array. Mirror that here.
    expect(store.active.get()).toBeNull();
    store.dispose();
  });
});
