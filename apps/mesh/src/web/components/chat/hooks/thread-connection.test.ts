import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  __resetRegistry,
  getOrOpenStream,
  type RequestOptions,
  type ThreadObserver,
} from "./thread-connection";

// ─── Fetch mock builders ─────────────────────────────────────────────────────

/** Build a fetch mock with explicit handlers per endpoint. Default: snapshot
 *  returns empty items; /messages 200s; /stream hangs until aborted. Each
 *  endpoint can be overridden. */
function makeFetchMock(
  opts: {
    snapshot?: () => Response;
    stream?: () => Response | Promise<Response>;
    messages?: () => Response;
    fallback?: (init?: RequestInit) => Promise<Response>;
  } = {},
) {
  const defaultSnapshot = () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { structuredContent: { items: [] } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const defaultStream = (init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
  const defaultMessages = () => new Response("ok", { status: 200 });

  return mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/mcp/self")) {
      return Promise.resolve(opts.snapshot?.() ?? defaultSnapshot());
    }
    if (url.includes("/stream")) {
      return Promise.resolve(opts.stream?.() ?? defaultStream(init));
    }
    if (url.includes("/messages")) {
      return Promise.resolve(opts.messages?.() ?? defaultMessages());
    }
    return opts.fallback?.(init) ?? defaultStream(init);
  });
}

/** Build a controllable /stream response — enqueue chunks at test time. */
function controllableStream() {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    enqueue: (chunk: unknown) => {
      if (!controller) throw new Error("stream not open");
      controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    },
    close: () => {
      controller?.close();
      controller = null;
    },
  };
}

const baseOpts: RequestOptions = {
  tier: "standard" as never,
  mode: "chat" as never,
  toolApprovalLevel: "readonly",
};

// ─── Test scaffolding ────────────────────────────────────────────────────────

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  __resetRegistry();
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  __resetRegistry();
  globalThis.fetch = originalFetch;
});

// ─── Registry singleton ──────────────────────────────────────────────────────

describe("getOrOpenStream", () => {
  test("returns the same instance for the same key", () => {
    globalThis.fetch = makeFetchMock() as unknown as typeof globalThis.fetch;
    const a = getOrOpenStream("acme", "thread-1");
    const b = getOrOpenStream("acme", "thread-1");
    expect(a).toBe(b);
  });

  test("disposes the prior connection when key changes", () => {
    globalThis.fetch = makeFetchMock() as unknown as typeof globalThis.fetch;
    const a = getOrOpenStream("acme", "thread-1");
    const aSpy = mock(() => {});
    a.abort.signal.addEventListener("abort", aSpy);

    const b = getOrOpenStream("acme", "thread-2");

    expect(a).not.toBe(b);
    expect(aSpy).toHaveBeenCalledTimes(1);
    expect(a.abort.signal.aborted).toBe(true);
  });
});

// ─── Bootstrap ───────────────────────────────────────────────────────────────

describe("bootstrap", () => {
  test("loads server snapshot into messages and transitions to ready", async () => {
    const seedMessages = [
      { id: "u-1", role: "user", parts: [{ type: "text", text: "hi" }] },
    ];
    globalThis.fetch = makeFetchMock({
      snapshot: () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { structuredContent: { items: seedMessages } },
          }),
          { status: 200 },
        ),
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-boot");
    expect(conn.status.get()).toEqual({ kind: "loading" });
    await new Promise((r) => setTimeout(r, 20));

    expect(conn.status.get()).toEqual({ kind: "ready" });
    expect(conn.messages.get()).toEqual(seedMessages as never);
  });

  test("error during snapshot fetch transitions to status=error", async () => {
    globalThis.fetch = makeFetchMock({
      snapshot: () => new Response("boom", { status: 500 }),
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-boot-err");
    await new Promise((r) => setTimeout(r, 20));

    const s = conn.status.get();
    expect(s.kind).toBe("error");
  });
});

// ─── SSE chunk handling ──────────────────────────────────────────────────────

describe("chunk handling", () => {
  test("folds a complete run into messages and sets finishReason", async () => {
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-fold");
    await new Promise((r) => setTimeout(r, 20)); // bootstrap

    stream.enqueue({ type: "start", messageId: "m-1" });
    stream.enqueue({ type: "text-start", id: "p-1" });
    stream.enqueue({ type: "text-delta", id: "p-1", delta: "hello" });
    stream.enqueue({ type: "text-end", id: "p-1" });
    stream.enqueue({ type: "finish", finishReason: "stop" });

    await new Promise((r) => setTimeout(r, 10));

    expect(conn.status.get()).toEqual({ kind: "ready" });
    expect(conn.finishReason.get()).toBe("stop");
    const msgs = conn.messages.get();
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.at(-1)?.role).toBe("assistant");
    expect(msgs.at(-1)?.id).toBe("m-1");
  });

  test("observer.onFinish fires once per run", async () => {
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-obs");
    const finishSpy = mock(() => {});
    conn.observer = { onFinish: finishSpy } as ThreadObserver;
    await new Promise((r) => setTimeout(r, 20));

    stream.enqueue({ type: "start", messageId: "m-1" });
    stream.enqueue({ type: "text-start", id: "p-1" });
    stream.enqueue({ type: "text-delta", id: "p-1", delta: "x" });
    stream.enqueue({ type: "text-end", id: "p-1" });
    stream.enqueue({ type: "finish", finishReason: "stop" });

    await new Promise((r) => setTimeout(r, 10));
    expect(finishSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── submit() — single mutator entry point ───────────────────────────────────

describe("submit", () => {
  test("toolOutput patches the matching part and POSTs", async () => {
    const stream = controllableStream();
    const messagesFetch = mock(() => new Response("ok", { status: 200 }));
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/mcp/self")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { structuredContent: { items: [] } },
            }),
            { status: 200 },
          ),
        );
      }
      if (url.includes("/stream")) return Promise.resolve(stream.response);
      if (
        url.includes("/messages") &&
        !url.includes("/decopilot/threads/") === false
      ) {
        return Promise.resolve(messagesFetch());
      }
      if (url.includes("/messages")) return Promise.resolve(messagesFetch());
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-submit");
    await new Promise((r) => setTimeout(r, 20));

    // Stage a pending user_ask via the SSE.
    stream.enqueue({ type: "start", messageId: "m-1" });
    stream.enqueue({ type: "start-step" });
    stream.enqueue({
      type: "tool-input-available",
      toolCallId: "toolu_X",
      toolName: "user_ask",
      input: { prompt: "?" },
    });
    stream.enqueue({ type: "finish", finishReason: "tool-calls" });
    await new Promise((r) => setTimeout(r, 10));

    // Pre-submit state.
    const before = conn.messages.get().at(-1);
    const partBefore = before?.parts.find(
      (p) => (p as { toolCallId?: string }).toolCallId === "toolu_X",
    ) as { state?: string } | undefined;
    expect(partBefore?.state).toBe("input-available");

    await conn.submit(
      { kind: "toolOutput", toolCallId: "toolu_X", output: { ok: true } },
      baseOpts,
    );

    const after = conn.messages.get().at(-1);
    const partAfter = after?.parts.find(
      (p) => (p as { toolCallId?: string }).toolCallId === "toolu_X",
    ) as { state?: string; output?: unknown } | undefined;
    expect(partAfter?.state).toBe("output-available");
    expect(partAfter?.output).toEqual({ ok: true });
    expect(messagesFetch).toHaveBeenCalledTimes(1);
  });

  test("toolOutput throws if toolCallId is not found", async () => {
    globalThis.fetch = makeFetchMock() as unknown as typeof globalThis.fetch;
    const conn = getOrOpenStream("acme", "thread-missing");
    await new Promise((r) => setTimeout(r, 20));

    await expect(
      conn.submit(
        { kind: "toolOutput", toolCallId: "nope", output: {} },
        baseOpts,
      ),
    ).rejects.toThrow(/target not found/);
  });

  test("submit clears finishReason synchronously", async () => {
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-cf");
    await new Promise((r) => setTimeout(r, 20));

    // Stage a pending user_ask and let finishReason settle to "tool-calls".
    stream.enqueue({ type: "start", messageId: "m-1" });
    stream.enqueue({
      type: "tool-input-available",
      toolCallId: "toolu_F",
      toolName: "user_ask",
      input: { prompt: "?" },
    });
    stream.enqueue({ type: "finish", finishReason: "tool-calls" });
    await new Promise((r) => setTimeout(r, 10));
    expect(conn.finishReason.get()).toBe("tool-calls");

    // submit() returns a promise but the finishReason clear is synchronous.
    const p = conn.submit(
      { kind: "toolOutput", toolCallId: "toolu_F", output: { ok: true } },
      baseOpts,
    );
    expect(conn.finishReason.get()).toBe(null);
    await p;
  });
});

// ─── refresh() ───────────────────────────────────────────────────────────────

describe("refresh", () => {
  test("re-fetches snapshot and replaces messages", async () => {
    let returnNewSnapshot = false;
    const initial = [
      { id: "u-1", role: "user", parts: [{ type: "text", text: "old" }] },
    ];
    const updated = [
      { id: "u-1", role: "user", parts: [{ type: "text", text: "old" }] },
      { id: "a-1", role: "assistant", parts: [{ type: "text", text: "new" }] },
    ];
    globalThis.fetch = makeFetchMock({
      snapshot: () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              structuredContent: {
                items: returnNewSnapshot ? updated : initial,
              },
            },
          }),
          { status: 200 },
        ),
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-refresh");
    await new Promise((r) => setTimeout(r, 20));
    expect(conn.messages.get().length).toBe(1);

    returnNewSnapshot = true;
    await conn.refresh();

    expect(conn.messages.get().length).toBe(2);
  });

  test("refresh is a no-op while a submit POST is in flight", async () => {
    const stream = controllableStream();
    let resolveMessagesPost: (() => void) | null = null;
    const snapshotCalls: number[] = [];
    let snapshotCallCount = 0;

    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/mcp/self")) {
        snapshotCallCount++;
        snapshotCalls.push(snapshotCallCount);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { structuredContent: { items: [] } },
            }),
            { status: 200 },
          ),
        );
      }
      if (url.includes("/stream")) return Promise.resolve(stream.response);
      if (url.includes("/messages")) {
        // Hold the POST open so status stays "submitted".
        return new Promise<Response>((resolve) => {
          resolveMessagesPost = () =>
            resolve(new Response("ok", { status: 200 }));
        });
      }
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-refresh-guard");
    await new Promise((r) => setTimeout(r, 20));
    const snapshotCallsAfterBoot = snapshotCallCount;

    // Stage a pending tool.
    stream.enqueue({ type: "start", messageId: "m-1" });
    stream.enqueue({
      type: "tool-input-available",
      toolCallId: "toolu_G",
      toolName: "user_ask",
      input: {},
    });
    stream.enqueue({ type: "finish", finishReason: "tool-calls" });
    await new Promise((r) => setTimeout(r, 10));

    // Kick off a submit — POST is held open.
    const submitPromise = conn.submit(
      { kind: "toolOutput", toolCallId: "toolu_G", output: {} },
      baseOpts,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(conn.status.get().kind).toBe("submitted");

    // refresh() should bail without issuing a snapshot fetch.
    await conn.refresh();
    expect(snapshotCallCount).toBe(snapshotCallsAfterBoot);

    // Settle the POST so the test cleans up.
    (resolveMessagesPost as (() => void) | null)?.();
    await submitPromise;
  });
});
