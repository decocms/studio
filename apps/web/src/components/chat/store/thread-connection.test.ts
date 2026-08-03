import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  __resetRegistry,
  dropRedundantStubs,
  getOrOpenStream,
  mergeAndSort,
  reconcileLatestPage,
  type RequestOptions,
  type ThreadObserver,
  upsertById,
} from "./thread-connection";
import type { UIMessage, UIMessageChunk } from "ai";

// ─── Fetch mock builders ─────────────────────────────────────────────────────

/** Build a fetch mock with explicit handlers per endpoint. Default: /messages
 *  200s; /stream hangs until aborted. Each endpoint can be overridden. */
function makeFetchMock(
  opts: {
    stream?: (init?: RequestInit) => Response | Promise<Response>;
    messages?: (init?: RequestInit) => Response | Promise<Response>;
    fallback?: (init?: RequestInit) => Promise<Response>;
  } = {},
) {
  const defaultStream = (init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => {
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const defaultMessages = () => new Response("ok", { status: 200 });

  return mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/stream")) {
      return Promise.resolve(opts.stream?.(init) ?? defaultStream(init));
    }
    if (url.includes("/messages")) {
      return Promise.resolve(opts.messages?.(init) ?? defaultMessages());
    }
    return (
      opts.fallback?.(init) ??
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })
    );
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
  test("with null client, transitions to ready immediately after SSE opens", async () => {
    globalThis.fetch = makeFetchMock() as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-boot-null", { client: null });
    expect(conn.status.get()).toEqual({ kind: "loading" });
    await new Promise((r) => setTimeout(r, 20));

    expect(conn.status.get()).toEqual({ kind: "ready" });
    expect(conn.messages.get()).toEqual([]);
  });

  test("HTTP error on /stream transitions to status=error", async () => {
    globalThis.fetch = makeFetchMock({
      stream: () => new Response("boom", { status: 500 }),
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-boot-err", { client: null });
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

    const conn = getOrOpenStream("acme", "thread-fold", { client: null });
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

  test("in-flight reply sorts after its user turn despite a client-ahead clock skew", async () => {
    // The optimistic user row is stamped with the CLIENT clock; the streamed
    // reply arrives carrying a SERVER-clock `metadata.created_at`. If the
    // client is ahead of the server, the reply's timestamp predates the user's
    // and it would sort AHEAD of its own turn — pairing then shows "No response
    // was generated" on the turn that triggered the run. Regression guard.
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-skew", { client: null });
    await new Promise((r) => setTimeout(r, 20));

    await conn.submit(
      {
        kind: "message",
        message: {
          id: "u-2",
          role: "user",
          parts: [{ type: "text", text: "hi" }],
        },
      },
      baseOpts,
    );

    // Server run-start metadata 5s in the PAST relative to the just-stamped
    // client user row — simulates a client clock running ahead of the server.
    const serverStart = new Date(Date.now() - 5_000).toISOString();
    stream.enqueue({
      type: "start",
      messageId: "m-2",
      messageMetadata: { created_at: serverStart },
    });
    stream.enqueue({ type: "text-start", id: "p-2" });
    stream.enqueue({ type: "text-delta", id: "p-2", delta: "fresh" });
    stream.enqueue({ type: "text-end", id: "p-2" });
    stream.enqueue({ type: "finish", finishReason: "stop" });
    await new Promise((r) => setTimeout(r, 50));

    expect(conn.messages.get().map((m) => m.id)).toEqual(["u-2", "m-2"]);
  });

  test("observer.onFinish fires once per run", async () => {
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-obs", { client: null });
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

  test("tracks local sending and received states around POST /messages", async () => {
    globalThis.fetch = makeFetchMock() as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-status-post", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20));

    const submitPromise = conn.submit(
      {
        kind: "message",
        message: {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        },
      },
      baseOpts,
    );

    expect(conn.runStatusStage.get()).toBe("sending");
    await submitPromise;
    expect(conn.runStatusStage.get()).toBe("received");
  });

  test("consumes data-run-status without creating assistant content", async () => {
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-status-chunk", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20));

    stream.enqueue({
      type: "data-run-status",
      id: "run-status",
      data: { stage: "gathering-context" },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(conn.runStatusStage.get()).toBe("gathering-context");
    expect(conn.messages.get().filter((m) => m.role === "assistant")).toEqual(
      [],
    );
  });

  test("consumes unknown and malformed data-run-status without creating assistant content", async () => {
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-status-malformed", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20));

    stream.enqueue({
      type: "data-run-status",
      id: "run-status",
      data: { stage: "future-stage" },
    } as unknown as UIMessageChunk);
    stream.enqueue({
      type: "data-run-status",
      id: "run-status",
      data: {},
    } as unknown as UIMessageChunk);

    await new Promise((r) => setTimeout(r, 10));
    expect(conn.runStatusStage.get()).toBeNull();
    expect(conn.messages.get().filter((m) => m.role === "assistant")).toEqual(
      [],
    );
  });

  test("run status stage is monotonic across replayed chunks", async () => {
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-status-monotonic", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20));

    stream.enqueue({
      type: "data-run-status",
      id: "run-status",
      data: { stage: "preparing-tools" },
    });
    stream.enqueue({
      type: "data-run-status",
      id: "run-status",
      data: { stage: "starting-run" },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(conn.runStatusStage.get()).toBe("preparing-tools");
  });

  test("POST success does not regress a later streamed run status", async () => {
    const stream = controllableStream();
    let resolvePost!: () => void;
    const postGate = new Promise<void>((resolve) => {
      resolvePost = resolve;
    });
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
      messages: async () => {
        await postGate;
        return new Response("ok", { status: 200 });
      },
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-status-post-monotonic", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20));

    const submitPromise = conn.submit(
      {
        kind: "message",
        message: {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        },
      },
      baseOpts,
    );
    expect(conn.runStatusStage.get()).toBe("sending");

    stream.enqueue({
      type: "data-run-status",
      id: "run-status",
      data: { stage: "gathering-context" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(conn.runStatusStage.get()).toBe("gathering-context");

    resolvePost();
    await submitPromise;
    expect(conn.runStatusStage.get()).toBe("gathering-context");
  });

  test("POST success does not resurrect run status after visible output cleared it", async () => {
    const stream = controllableStream();
    let resolvePost!: () => void;
    const postGate = new Promise<void>((resolve) => {
      resolvePost = resolve;
    });
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
      messages: async () => {
        await postGate;
        return new Response("ok", { status: 200 });
      },
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-status-post-cleared", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20));

    const submitPromise = conn.submit(
      {
        kind: "message",
        message: {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        },
      },
      baseOpts,
    );
    expect(conn.runStatusStage.get()).toBe("sending");

    stream.enqueue({
      type: "data-run-status",
      id: "run-status",
      data: { stage: "gathering-context" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(conn.runStatusStage.get()).toBe("gathering-context");

    stream.enqueue({ type: "start", messageId: "m-1" });
    stream.enqueue({ type: "text-start", id: "p-1" });
    stream.enqueue({ type: "text-delta", id: "p-1", delta: "hello" });
    stream.enqueue({ type: "text-end", id: "p-1" });
    stream.enqueue({ type: "finish", finishReason: "stop" });
    await new Promise((r) => setTimeout(r, 10));
    expect(conn.runStatusStage.get()).toBeNull();

    resolvePost();
    await submitPromise;
    expect(conn.runStatusStage.get()).toBeNull();
  });

  test("start-step does not clear run status before visible output", async () => {
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-status-start-step", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20));

    stream.enqueue({
      type: "data-run-status",
      id: "run-status",
      data: { stage: "gathering-context" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(conn.runStatusStage.get()).toBe("gathering-context");

    stream.enqueue({ type: "start", messageId: "m-1" });
    stream.enqueue({ type: "start-step" });
    await new Promise((r) => setTimeout(r, 10));
    expect(conn.runStatusStage.get()).toBe("gathering-context");

    stream.enqueue({ type: "text-start", id: "p-1" });
    stream.enqueue({ type: "text-delta", id: "p-1", delta: "hello" });
    await new Promise((r) => setTimeout(r, 10));
    expect(conn.runStatusStage.get()).toBeNull();
  });

  test("clears run status when visible assistant content starts and on finish", async () => {
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-status-clear", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20));

    stream.enqueue({
      type: "data-run-status",
      id: "run-status",
      data: { stage: "analyzing-scope" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(conn.runStatusStage.get()).toBe("analyzing-scope");

    stream.enqueue({ type: "start", messageId: "m-1" });
    stream.enqueue({ type: "text-start", id: "p-1" });
    stream.enqueue({ type: "text-delta", id: "p-1", delta: "hello" });
    await new Promise((r) => setTimeout(r, 10));
    expect(conn.runStatusStage.get()).toBeNull();

    stream.enqueue({ type: "text-end", id: "p-1" });
    stream.enqueue({ type: "finish", finishReason: "stop" });
    await new Promise((r) => setTimeout(r, 10));
    expect(conn.runStatusStage.get()).toBeNull();
  });
});

// ─── stop() — late chunks from the cancelled run are dropped ────────────────

describe("stop", () => {
  test("late chunks from a cancelled run don't land on the next user turn", async () => {
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-stop-late", { client: null });
    await new Promise((r) => setTimeout(r, 20));

    // Run 1 starts streaming.
    stream.enqueue({ type: "start", messageId: "m-1" });
    stream.enqueue({ type: "text-start", id: "p-1" });
    stream.enqueue({ type: "text-delta", id: "p-1", delta: "partial" });
    await new Promise((r) => setTimeout(r, 10));

    expect(conn.messages.get().at(-1)?.id).toBe("m-1");

    // User clicks Stop mid-stream.
    conn.stop();
    expect(conn.status.get().kind).toBe("ready");

    // User immediately sends a new message before the cancelled run's tail
    // chunks have a chance to drain through the SSE.
    await conn.submit(
      {
        kind: "message",
        message: {
          id: "u-2",
          role: "user",
          parts: [{ type: "text", text: "second" }],
        },
      },
      baseOpts,
    );

    // Cancelled run's late chunks arrive AFTER the new user message — these
    // are exactly the chunks that previously got attributed to a phantom
    // assistant message appended after the user message.
    stream.enqueue({ type: "text-delta", id: "p-1", delta: " leftover" });
    stream.enqueue({ type: "text-end", id: "p-1" });
    stream.enqueue({ type: "finish", finishReason: "stop" });
    await new Promise((r) => setTimeout(r, 10));

    // Run 2 starts properly.
    stream.enqueue({ type: "start", messageId: "m-2" });
    stream.enqueue({ type: "text-start", id: "p-2" });
    stream.enqueue({ type: "text-delta", id: "p-2", delta: "fresh" });
    stream.enqueue({ type: "text-end", id: "p-2" });
    stream.enqueue({ type: "finish", finishReason: "stop" });
    await new Promise((r) => setTimeout(r, 50));

    const ids = conn.messages.get().map((m) => m.id);
    expect(ids).toEqual(["m-1", "u-2", "m-2"]);

    const textOf = (id: string) => {
      const m = conn.messages.get().find((x) => x.id === id);
      return (m?.parts ?? [])
        .filter((p) => (p as { type: string }).type === "text")
        .map((p) => (p as { text: string }).text)
        .join("");
    };
    // m-1 keeps its pre-stop content; the leftover delta is dropped.
    expect(textOf("m-1")).toBe("partial");
    // m-2 contains only run 2's content — no contamination from run 1.
    expect(textOf("m-2")).toBe("fresh");
  });

  test("accepts pre-start run status for a submitted run after stop", async () => {
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-stop-status", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20));

    stream.enqueue({ type: "start", messageId: "m-1" });
    stream.enqueue({ type: "text-start", id: "p-1" });
    stream.enqueue({ type: "text-delta", id: "p-1", delta: "partial" });
    await new Promise((r) => setTimeout(r, 10));

    conn.stop();

    stream.enqueue({
      type: "data-run-status",
      id: "run-status",
      data: { stage: "gathering-context" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(conn.runStatusStage.get()).toBeNull();

    await conn.submit(
      {
        kind: "message",
        message: {
          id: "u-2",
          role: "user",
          parts: [{ type: "text", text: "second" }],
        },
      },
      baseOpts,
    );

    stream.enqueue({
      type: "data-run-status",
      id: "run-status",
      data: { stage: "waiting-runner" },
    });
    stream.enqueue({ type: "text-delta", id: "p-1", delta: " leftover" });
    await new Promise((r) => setTimeout(r, 10));

    expect(conn.runStatusStage.get()).toBe("waiting-runner");

    stream.enqueue({ type: "start", messageId: "m-2" });
    stream.enqueue({ type: "text-start", id: "p-2" });
    stream.enqueue({ type: "text-delta", id: "p-2", delta: "fresh" });
    stream.enqueue({ type: "text-end", id: "p-2" });
    stream.enqueue({ type: "finish", finishReason: "stop" });
    await new Promise((r) => setTimeout(r, 50));

    const ids = conn.messages.get().map((m) => m.id);
    expect(ids).toEqual(["m-1", "u-2", "m-2"]);
  });

  test("clicking Stop while the POST is still in flight lands on ready, not error", async () => {
    globalThis.fetch = makeFetchMock({
      messages: (init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-stop-mid-post", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20));

    const submitPromise = conn.submit(
      {
        kind: "message",
        message: {
          id: "u-1",
          role: "user",
          parts: [{ type: "text", text: "hi" }],
        },
      },
      baseOpts,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(conn.status.get().kind).toBe("submitted");

    conn.stop();
    expect(conn.status.get().kind).toBe("ready");

    await submitPromise;
    // The aborted POST's rejection must not clobber the ready state stop()
    // already set with an error.
    expect(conn.status.get().kind).toBe("ready");
  });
});

// ─── submit() — single mutator entry point ───────────────────────────────────

describe("submit", () => {
  test("toolOutput patches the matching part and POSTs", async () => {
    const stream = controllableStream();
    const messagesFetch = mock(() => new Response("ok", { status: 200 }));
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/stream")) return Promise.resolve(stream.response);
      if (url.includes("/messages")) return Promise.resolve(messagesFetch());
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-submit", { client: null });
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
    const conn = getOrOpenStream("acme", "thread-missing", { client: null });
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

    const conn = getOrOpenStream("acme", "thread-cf", { client: null });
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

  test("POSTs only the hosted wire contract and omits caller-owned identities", async () => {
    let postedBody: Record<string, unknown> | null = null;
    globalThis.fetch = makeFetchMock({
      messages: (init) => {
        postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response("ok", { status: 200 });
      },
    }) as unknown as typeof globalThis.fetch;
    const conn = getOrOpenStream("acme", "canonical-thread", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20));

    // Retired fields are included through a cast to prove post() whitelists
    // the wire payload even when stale compiled JavaScript supplies them.
    const legacyOptions = {
      ...baseOpts,
      branch: "feature/hosted-contract",
      agent: { id: "different-agent" },
      thread_id: "different-thread",
      harnessId: "decopilot",
      sandboxProviderKind: "agent-sandbox",
    } as RequestOptions;
    await conn.submit(
      {
        kind: "message",
        message: {
          id: "hosted-contract-message",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        },
      },
      legacyOptions,
    );

    expect(postedBody).not.toBeNull();
    const body = postedBody as unknown as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "branch",
      "messages",
      "mode",
      "tier",
      "toolApprovalLevel",
    ]);
    expect(body.branch).toBe("feature/hosted-contract");
    expect(body).not.toHaveProperty("agent");
    expect(body).not.toHaveProperty("thread_id");
    expect(body).not.toHaveProperty("harnessId");
    expect(body).not.toHaveProperty("sandboxProviderKind");
  });

  test("stamps the optimistic user message with a top-level created_at", async () => {
    globalThis.fetch = makeFetchMock() as unknown as typeof globalThis.fetch;
    const conn = getOrOpenStream("acme", "thread-stamp", { client: null });
    await new Promise((r) => setTimeout(r, 20));

    await conn.submit(
      {
        kind: "message",
        message: {
          id: "user-stamp",
          role: "user",
          parts: [{ type: "text", text: "hi" }],
        },
      },
      baseOpts,
    );

    // Without the stamp the optimistic user row reads as +Infinity and the
    // assistant reply (finite metadata/finish timestamp) sorts ahead of it →
    // "No response was generated" on the turn that triggered the run.
    const userRow = conn.messages.get().find((m) => m.id === "user-stamp") as
      | (UIMessage & { created_at?: string })
      | undefined;
    expect(userRow?.created_at).toBeDefined();
    expect(Number.isFinite(new Date(userRow!.created_at!).getTime())).toBe(
      true,
    );
  });
});

// ─── enqueue() — quiet POST behind the active run, tray-only (no body append) ─

describe("enqueue", () => {
  test("POSTs quietly without touching status, runStatusStage, or the message store", async () => {
    let messagesCalls = 0;
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
      messages: () => {
        messagesCalls++;
        return new Response("ok", { status: 200 });
      },
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-enqueue-quiet", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20));

    // Put the running turn's status display in a non-null stage. "sending"
    // ranks BELOW "received", so a non-quiet POST would provably advance it
    // (see "tracks local sending and received states around POST /messages").
    stream.enqueue({
      type: "data-run-status",
      id: "run-status",
      data: { stage: "sending" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(conn.runStatusStage.get()).toBe("sending");
    const statusBefore = conn.status.get();
    const messagesBefore = conn.messages.get();

    await conn.enqueue(
      {
        id: "q-1",
        role: "user",
        parts: [{ type: "text", text: "queued behind the run" }],
      },
      baseOpts,
    );

    // The POST happened…
    expect(messagesCalls).toBe(1);
    // …but the body is untouched — tray-only until the dispatch-time flip
    // (same array reference: enqueue() never calls messages.set/update).
    expect(conn.messages.get()).toBe(messagesBefore);
    expect(conn.messages.get().map((m) => m.id)).not.toContain("q-1");
    // …and the running turn's status display is byte-for-byte untouched:
    // no "received" bump (quiet POST), no "submitted" status flip.
    expect(conn.runStatusStage.get()).toBe("sending");
    expect(conn.status.get()).toEqual(statusBefore);
    expect(conn.status.get().kind).not.toBe("submitted");
  });

  test("removeLocalMessage filters exactly the given row", async () => {
    globalThis.fetch = makeFetchMock() as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-enqueue-remove", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20));

    conn.applyLocalMessage({
      id: "q-1",
      role: "user",
      parts: [{ type: "text", text: "first" }],
    });
    conn.applyLocalMessage({
      id: "q-2",
      role: "user",
      parts: [{ type: "text", text: "second" }],
    });
    expect(conn.messages.get().map((m) => m.id)).toEqual(["q-1", "q-2"]);

    conn.removeLocalMessage("q-1");
    expect(conn.messages.get().map((m) => m.id)).toEqual(["q-2"]);
  });
});

// ─── applyLocalMessage() — dispatch-time tray→body flip ──────────────────────

describe("applyLocalMessage", () => {
  test("appends a message to the body", async () => {
    globalThis.fetch = makeFetchMock() as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-apply-local-message", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(conn.messages.get()).toEqual([]);
    conn.applyLocalMessage({
      id: "flip-1",
      role: "user",
      parts: [{ type: "text", text: "dispatched" }],
    });
    expect(conn.messages.get().map((m) => m.id)).toEqual(["flip-1"]);
  });

  test("dedupes by id when the row is already in the body (refetch raced the flip)", async () => {
    globalThis.fetch = makeFetchMock() as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-apply-local-dedupe", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20));

    // A server refetch (e.g. an SSE-reconnect refetchLatestPage) already
    // merged the persisted copy of the queued row into the body.
    conn.messages.set([
      {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "server copy" }],
        created_at: "2026-01-01T00:00:00.000Z",
      } as UIMessage,
      {
        id: "other",
        role: "assistant",
        parts: [{ type: "text", text: "reply" }],
        created_at: "2026-01-01T00:00:01.000Z",
      } as UIMessage,
    ]);

    conn.applyLocalMessage({
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "stashed copy" }],
    });

    const msgs = conn.messages.get();
    // Exactly ONE m1 — the flip must not duplicate a row a refetch already
    // merged in.
    expect(msgs.filter((m) => m.id === "m1")).toHaveLength(1);
    // mergeAndSort's Map-by-id rebuild is last-entry-wins for duplicates
    // within the list, so the just-applied (stashed) version replaces the
    // earlier server copy — and applyLocally stamps it with a fresh
    // created_at strictly after every existing row, so it sorts last.
    const m1 = msgs.find((m) => m.id === "m1");
    expect(
      (m1?.parts?.[0] as { type: string; text?: string } | undefined)?.text,
    ).toBe("stashed copy");
    expect(msgs.map((m) => m.id)).toEqual(["other", "m1"]);
  });
});

// ─── submit() — defer POST while client-side resolutions are pending ─────────

describe("submit defers POST", () => {
  /** Stage one or more pending approval parts and one optional pending
   *  user_ask part on a single assistant turn. */
  async function stageTurn(
    stream: ReturnType<typeof controllableStream>,
    spec: {
      approvalIds: string[];
      userAskToolCallId?: string;
    },
  ): Promise<void> {
    stream.enqueue({ type: "start", messageId: "m-1" });
    stream.enqueue({ type: "start-step" });
    for (const id of spec.approvalIds) {
      stream.enqueue({
        type: "tool-input-available",
        toolCallId: `tc-${id}`,
        toolName: "dangerous_thing",
        input: { x: id },
      });
      stream.enqueue({
        type: "tool-approval-request",
        toolCallId: `tc-${id}`,
        approvalId: id,
      });
    }
    if (spec.userAskToolCallId) {
      stream.enqueue({
        type: "tool-input-available",
        toolCallId: spec.userAskToolCallId,
        toolName: "user_ask",
        input: { prompt: "?" },
      });
    }
    stream.enqueue({ type: "finish", finishReason: "tool-calls" });
    await new Promise((r) => setTimeout(r, 10));
  }

  test("single approval posts one selectorless continuation", async () => {
    let messagesCalls = 0;
    let postedBody: Record<string, unknown> | null = null;
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
      messages: (init) => {
        messagesCalls++;
        postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response("ok", { status: 200 });
      },
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-single-appr", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20));
    await stageTurn(stream, { approvalIds: ["a1"] });

    await conn.submit({ kind: "approval", approvalId: "a1", approved: true }, {
      ...baseOpts,
      agent: { id: "retired-agent" },
      thread_id: "retired-thread",
      harnessId: "decopilot",
      sandboxProviderKind: "agent-sandbox",
    } as RequestOptions);

    expect(messagesCalls).toBe(1);
    const body = postedBody as unknown as {
      messages: Array<{ role: string }>;
      [key: string]: unknown;
    };
    expect(body.messages.at(-1)?.role).toBe("assistant");
    expect(body).not.toHaveProperty("agent");
    expect(body).not.toHaveProperty("thread_id");
    expect(body).not.toHaveProperty("harnessId");
    expect(body).not.toHaveProperty("sandboxProviderKind");
  });

  test("3 approvals, accept first only → no POST, local state updated", async () => {
    let messagesCalls = 0;
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
      messages: () => {
        messagesCalls++;
        return new Response("ok", { status: 200 });
      },
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-3-appr-one", { client: null });
    await new Promise((r) => setTimeout(r, 20));
    await stageTurn(stream, { approvalIds: ["a1", "a2", "a3"] });

    await conn.submit(
      { kind: "approval", approvalId: "a1", approved: true },
      baseOpts,
    );

    expect(messagesCalls).toBe(0);
    // Local patch applied.
    const last = conn.messages.get().at(-1);
    const states = (last?.parts ?? [])
      .filter((p) => (p as { approval?: unknown }).approval !== undefined)
      .map((p) => (p as { state: string }).state);
    expect(states).toEqual([
      "approval-responded",
      "approval-requested",
      "approval-requested",
    ]);
    // Status must not be stuck on "submitted" since no POST is in flight.
    expect(conn.status.get().kind).not.toBe("submitted");
  });

  test("3 approvals, accept all sequentially → one POST on the last", async () => {
    let messagesCalls = 0;
    let lastBody: unknown = null;
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
      messages: (init) => {
        messagesCalls++;
        lastBody = init?.body ? JSON.parse(String(init.body)) : null;
        return new Response("ok", { status: 200 });
      },
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-3-appr-all", { client: null });
    await new Promise((r) => setTimeout(r, 20));
    await stageTurn(stream, { approvalIds: ["a1", "a2", "a3"] });

    for (const id of ["a1", "a2", "a3"]) {
      await conn.submit(
        { kind: "approval", approvalId: id, approved: true },
        baseOpts,
      );
    }

    expect(messagesCalls).toBe(1);
    const body = lastBody as {
      messages: Array<{ parts: Array<{ state?: string }> }>;
    };
    const lastMsg = body.messages.at(-1);
    const respondedCount = (lastMsg?.parts ?? []).filter(
      (p) => p.state === "approval-responded",
    ).length;
    expect(respondedCount).toBe(3);
  });

  test("user_ask + approval, answer user_ask only → no POST", async () => {
    let messagesCalls = 0;
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
      messages: () => {
        messagesCalls++;
        return new Response("ok", { status: 200 });
      },
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-mixed-ask-only", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20));
    await stageTurn(stream, {
      approvalIds: ["a1"],
      userAskToolCallId: "tc-ua",
    });

    await conn.submit(
      { kind: "toolOutput", toolCallId: "tc-ua", output: { response: "yes" } },
      baseOpts,
    );

    expect(messagesCalls).toBe(0);
  });

  test("user_ask + approval, answer both → one POST after the second", async () => {
    let messagesCalls = 0;
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
      messages: () => {
        messagesCalls++;
        return new Response("ok", { status: 200 });
      },
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-mixed-both", { client: null });
    await new Promise((r) => setTimeout(r, 20));
    await stageTurn(stream, {
      approvalIds: ["a1"],
      userAskToolCallId: "tc-ua",
    });

    await conn.submit(
      { kind: "toolOutput", toolCallId: "tc-ua", output: { response: "yes" } },
      baseOpts,
    );
    expect(messagesCalls).toBe(0);

    await conn.submit(
      { kind: "approval", approvalId: "a1", approved: true },
      baseOpts,
    );
    expect(messagesCalls).toBe(1);
  });

  test("no x-idempotency-key header on POST", async () => {
    let observedHeaders: Headers | null = null;
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
      messages: (init) => {
        observedHeaders = new Headers(init?.headers);
        return new Response("ok", { status: 200 });
      },
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-no-idem", { client: null });
    await new Promise((r) => setTimeout(r, 20));
    await stageTurn(stream, { approvalIds: ["a1"] });

    await conn.submit(
      { kind: "approval", approvalId: "a1", approved: true },
      baseOpts,
    );

    expect(observedHeaders).not.toBeNull();
    expect(observedHeaders!.get("x-idempotency-key")).toBeNull();
  });
});

// ─── mergeAndSort ────────────────────────────────────────────────────────────

describe("mergeAndSort", () => {
  // Persisted ThreadMessage rows put `created_at` at the top level. We model
  // that here, not on `metadata`, because the production tool's output schema
  // is `ThreadMessageEntitySchema` which declares created_at at top level.
  function msg(
    id: string,
    createdAt: string | undefined,
    role: "user" | "assistant" = "user",
  ): UIMessage {
    return {
      id,
      role,
      parts: [{ type: "text", text: id }],
      ...(createdAt !== undefined ? { created_at: createdAt } : {}),
      // biome-ignore lint/suspicious/noExplicitAny: test helper
    } as any;
  }

  test("empty prev + ordered incoming → returns incoming sorted ascending", () => {
    const incoming = [
      msg("a", "2026-01-01T00:00:00Z"),
      msg("b", "2026-01-01T00:00:02Z"),
      msg("c", "2026-01-01T00:00:01Z"),
    ];
    const out = mergeAndSort([], incoming);
    expect(out.map((m) => m.id)).toEqual(["a", "c", "b"]);
  });

  test("upserts an id present in both — incoming wins", () => {
    const prev = [msg("a", "2026-01-01T00:00:00Z", "user")];
    const incoming = [msg("a", "2026-01-01T00:00:00Z", "assistant")];
    const out = mergeAndSort(prev, incoming);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe("assistant");
  });

  test("interleaves an incoming row between two prev rows by timestamp", () => {
    const prev = [
      msg("a", "2026-01-01T00:00:00Z"),
      msg("c", "2026-01-01T00:00:02Z"),
    ];
    const incoming = [msg("b", "2026-01-01T00:00:01Z")];
    expect(mergeAndSort(prev, incoming).map((m) => m.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("messages without created_at sort to the end (newest position)", () => {
    const prev = [msg("a", "2026-01-01T00:00:00Z")];
    const incoming = [msg("opt", undefined)];
    expect(mergeAndSort(prev, incoming).map((m) => m.id)).toEqual(["a", "opt"]);
  });

  test("timestamp-less incoming does NOT strip an existing created_at (replay)", () => {
    // deliverPolicy:"all" reconnect replays turn-1's assistant as a streamed
    // (timestamp-less) UIMessage over the DB-seeded row. Without preservation
    // it loses created_at → sorts to the end → renders under turn-2's user.
    const prev = [
      msg("u1", "2026-01-01T00:00:00Z", "user"),
      msg("a1", "2026-01-01T00:00:01Z", "assistant"),
      msg("u2", "2026-01-01T00:00:02Z", "user"),
    ];
    const replayedA1 = msg("a1", undefined, "assistant");
    const out = mergeAndSort(prev, [replayedA1]);
    expect(out.map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
  });

  test("stable id tiebreaker when two rows share a timestamp", () => {
    const incoming = [
      msg("z", "2026-01-01T00:00:00Z"),
      msg("a", "2026-01-01T00:00:00Z"),
    ];
    expect(mergeAndSort([], incoming).map((m) => m.id)).toEqual(["a", "z"]);
  });

  test("both arrays empty → returns empty array", () => {
    expect(mergeAndSort([], [])).toEqual([]);
  });

  test("numeric created_at sorts correctly alongside string timestamps", () => {
    const prev = [msg("a", "2026-01-01T00:00:00Z")];
    const numericMsg = {
      ...msg("b", undefined),
      created_at: new Date("2026-01-01T00:00:01Z").getTime(),
    } as UIMessage;
    expect(mergeAndSort(prev, [numericMsg]).map((m) => m.id)).toEqual([
      "a",
      "b",
    ]);
  });

  test("duplicate ids within incoming → last write wins", () => {
    const incoming = [
      msg("dup", "2026-01-01T00:00:00Z", "user"),
      msg("dup", "2026-01-01T00:00:00Z", "assistant"),
    ];
    const out = mergeAndSort([], incoming);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe("assistant");
  });

  test("in-flight turn-1 assistant (metadata only) stays before turn-2 user", () => {
    const wrongOrder = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
        created_at: "2026-06-09T12:00:00.000Z",
        // biome-ignore lint/suspicious/noExplicitAny: test helper
      } as any,
      {
        id: "u2",
        role: "user",
        parts: [{ type: "text", text: "second" }],
        metadata: { created_at: "2026-06-09T12:00:05.000Z" },
        // biome-ignore lint/suspicious/noExplicitAny: test helper
      } as any,
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "Hello!" }],
        metadata: { created_at: "2026-06-09T12:00:01.000Z" },
        // biome-ignore lint/suspicious/noExplicitAny: test helper
      } as any,
    ];
    expect(mergeAndSort(wrongOrder, []).map((m) => m.id)).toEqual([
      "u1",
      "a1",
      "u2",
    ]);
  });

  test("user metadata.created_at sorts before in-flight assistant (+Infinity)", () => {
    const wrongOrder = [
      {
        id: "u1",
        role: "user",
        parts: [],
        created_at: "2026-06-09T12:00:00.000Z",
        // biome-ignore lint/suspicious/noExplicitAny: test helper
      } as any,
      {
        id: "a1",
        role: "assistant",
        parts: [],
        created_at: "2026-06-09T12:00:01.000Z",
        // biome-ignore lint/suspicious/noExplicitAny: test helper
      } as any,
      {
        id: "a2",
        role: "assistant",
        parts: [{ type: "reasoning", text: "thinking" }],
        // biome-ignore lint/suspicious/noExplicitAny: test helper
      } as any,
      {
        id: "u2",
        role: "user",
        parts: [{ type: "text", text: "second" }],
        metadata: { created_at: "2026-06-09T12:00:02.000Z" },
        // biome-ignore lint/suspicious/noExplicitAny: test helper
      } as any,
    ];
    expect(mergeAndSort(wrongOrder, []).map((m) => m.id)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
    ]);
  });

  test("metadata.created_at is ignored for assistant — only top-level created_at is used", () => {
    // Regression: persisted assistant rows in the wild carry
    // `metadata.created_at` stamped at the run-start time, which is EARLIER
    // than the user message they answer. If readTimestamp pulled from
    // metadata, the assistant would sort before its preceding user, and
    // useMessagePairs would discard it as an orphan → "No response was
    // generated" empty-state bug.
    const userMsg = {
      id: "u-1",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
      created_at: "2026-05-20T18:10:04.851Z",
      // biome-ignore lint/suspicious/noExplicitAny: test helper
    } as any;
    const assistantMsg = {
      id: "msg_A",
      role: "assistant",
      parts: [{ type: "text", text: "hello" }],
      created_at: "2026-05-20T18:10:06.953Z", // actually persisted later
      metadata: { created_at: "2026-05-20T18:10:04.876Z" }, // stamped at run-start
      // biome-ignore lint/suspicious/noExplicitAny: test helper
    } as any;
    expect(mergeAndSort([], [assistantMsg, userMsg]).map((m) => m.id)).toEqual([
      "u-1",
      "msg_A",
    ]);
  });
});

// ─── reconcileLatestPage ─────────────────────────────────────────────────────

describe("reconcileLatestPage", () => {
  function msg(
    id: string,
    createdAt: string | undefined,
    role: "user" | "assistant" = "user",
  ): UIMessage {
    return {
      id,
      role,
      parts: [{ type: "text", text: id }],
      ...(createdAt !== undefined ? { created_at: createdAt } : {}),
      // biome-ignore lint/suspicious/noExplicitAny: test helper
    } as any;
  }

  test("empty fetched → returns current unchanged", () => {
    const current = [msg("u1", "2026-01-01T00:00:00Z")];
    expect(reconcileLatestPage(current, [])).toBe(current);
  });

  test("drops a transient in-flight assistant absent from the authoritative fetch", () => {
    // The queued turn's reply folded into a transient client id and clobbered
    // the prior turn. The fetch is DB truth; the transient must be dropped, not
    // duplicated.
    const current = [
      msg("u1", "2026-01-01T00:00:00Z", "user"),
      msg("transient", undefined, "assistant"), // +Infinity, not in fetch
    ];
    const fetched = [
      msg("u1", "2026-01-01T00:00:00Z", "user"),
      msg("a1", "2026-01-01T00:00:01Z", "assistant"),
    ];
    const out = reconcileLatestPage(current, fetched);
    expect(out.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(out.some((m) => m.id === "transient")).toBe(false);
  });

  test("renders the dequeued turn's user bubble + reply from the fetch", () => {
    // Live store only has the prior turn (msg1) + a clobbered transient holding
    // msg2's answer. After reconcile, msg2's user bubble and its real reply
    // appear in order, and the transient is gone.
    const current = [
      msg("u-msg1", "2026-01-01T00:00:00Z", "user"),
      msg("transient", undefined, "assistant"), // holds "4", wrong slot
    ];
    const fetched = [
      msg("u-msg1", "2026-01-01T00:00:00Z", "user"),
      msg("a-msg1", "2026-01-01T00:00:01Z", "assistant"),
      msg("u-msg2", "2026-01-01T00:00:02Z", "user"),
      msg("a-msg2", "2026-01-01T00:00:03Z", "assistant"),
    ];
    const out = reconcileLatestPage(current, fetched);
    expect(out.map((m) => m.id)).toEqual([
      "u-msg1",
      "a-msg1",
      "u-msg2",
      "a-msg2",
    ]);
  });

  test("keeps older-page assistant rows below the fetched window", () => {
    // An assistant from an earlier page (older than the fetch's oldest row) is
    // not in the fetch but must survive — it's history, not a transient.
    const current = [
      msg("old-a", "2026-01-01T00:00:00Z", "assistant"), // older than cutoff
      msg("u2", "2026-01-01T00:00:05Z", "user"),
    ];
    const fetched = [
      msg("u2", "2026-01-01T00:00:05Z", "user"),
      msg("a2", "2026-01-01T00:00:06Z", "assistant"),
    ];
    const out = reconcileLatestPage(current, fetched);
    expect(out.map((m) => m.id)).toEqual(["old-a", "u2", "a2"]);
  });

  test("never drops user rows even when absent from the fetch", () => {
    // An optimistic user row for a not-yet-terminal turn must survive a
    // reconcile triggered by a different turn's terminal.
    const current = [
      msg("u1", "2026-01-01T00:00:00Z", "user"),
      msg("u-optimistic", undefined, "user"), // +Infinity, not in fetch
    ];
    const fetched = [msg("u1", "2026-01-01T00:00:00Z", "user")];
    const out = reconcileLatestPage(current, fetched);
    expect(out.some((m) => m.id === "u-optimistic")).toBe(true);
  });

  test("upserts a persisted row already present in current (fetch wins)", () => {
    const current = [msg("a1", undefined, "assistant")]; // streamed, no ts
    const fetched = [msg("a1", "2026-01-01T00:00:01Z", "assistant")];
    const out = reconcileLatestPage(current, fetched);
    expect(out).toHaveLength(1);
    expect((out[0] as { created_at?: string }).created_at).toBe(
      "2026-01-01T00:00:01Z",
    );
  });
});

// ─── applyReconcile (live-run guard) ─────────────────────────────────────────

describe("applyReconcile", () => {
  function msg(
    id: string,
    createdAt: string | undefined,
    role: "user" | "assistant" = "user",
  ): UIMessage {
    return {
      id,
      role,
      parts: [{ type: "text", text: id }],
      ...(createdAt !== undefined ? { created_at: createdAt } : {}),
      // biome-ignore lint/suspicious/noExplicitAny: test helper
    } as any;
  }

  test("skips the apply while a run is live — the live transient survives", async () => {
    globalThis.fetch = makeFetchMock() as unknown as typeof globalThis.fetch;
    const conn = getOrOpenStream("acme", "thread-reconcile-guard", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20)); // bootstrap → ready

    // Turn B is streaming: its reply is a transient (no created_at) assistant
    // row not yet persisted. A reconcile fetch triggered by turn A's terminal
    // resolves NOW — applying it would drop B's live row mid-stream, since
    // it's indistinguishable from a stale transient.
    const live = [
      msg("u1", "2026-01-01T00:00:00Z", "user"),
      msg("b-transient", undefined, "assistant"),
    ];
    conn.messages.set(live);
    conn.status.set({ kind: "streaming" });

    const fetched = [
      msg("u1", "2026-01-01T00:00:00Z", "user"),
      msg("a1", "2026-01-01T00:00:01Z", "assistant"),
    ];
    expect(conn.applyReconcile(fetched, false)).toBe(false);
    expect(conn.messages.get()).toBe(live); // untouched — not even re-merged

    // "submitted" (POST sent, first chunk pending) must skip too.
    conn.status.set({ kind: "submitted" });
    expect(conn.applyReconcile(fetched, false)).toBe(false);
    expect(conn.messages.get()).toBe(live);
  });

  test("applies when idle — stale transient drops and hasMore lands", async () => {
    globalThis.fetch = makeFetchMock() as unknown as typeof globalThis.fetch;
    const conn = getOrOpenStream("acme", "thread-reconcile-apply", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20)); // bootstrap → ready

    conn.messages.set([
      msg("u1", "2026-01-01T00:00:00Z", "user"),
      msg("stale-transient", undefined, "assistant"),
    ]);
    const fetched = [
      msg("u1", "2026-01-01T00:00:00Z", "user"),
      msg("a1", "2026-01-01T00:00:01Z", "assistant"),
    ];
    expect(conn.applyReconcile(fetched, true)).toBe(true);
    expect(conn.messages.get().map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(conn.hasMoreOlder.get()).toBe(true);
  });
});

// ─── async-research stub dedup ───────────────────────────────────────────────

describe("upsertById", () => {
  function msg(
    id: string,
    createdAt: string | undefined,
    role: "user" | "assistant" = "assistant",
  ): UIMessage {
    return {
      id,
      role,
      parts: [{ type: "text", text: id }],
      ...(createdAt !== undefined ? { created_at: createdAt } : {}),
      // biome-ignore lint/suspicious/noExplicitAny: test helper
    } as any;
  }

  test("appends when id is absent", () => {
    const out = upsertById([msg("a", "t0")], msg("b", "t1"));
    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
  });

  test("replaces in place and keeps the prior created_at when incoming lacks one", () => {
    const prev = [msg("a", "2026-01-01T00:00:01Z")];
    const streamed = msg("a", undefined);
    const out = upsertById(prev, streamed);
    expect(out).toHaveLength(1);
    expect((out[0] as { created_at?: unknown }).created_at).toBe(
      "2026-01-01T00:00:01Z",
    );
    // fresher parts from the streamed copy are still applied
    expect(out[0]?.parts).toEqual(streamed.parts);
  });

  test("incoming created_at overwrites when present (persisted update)", () => {
    const prev = [msg("a", "2026-01-01T00:00:01Z")];
    const out = upsertById(prev, msg("a", "2026-01-01T00:00:09Z"));
    expect((out[0] as { created_at?: unknown }).created_at).toBe(
      "2026-01-01T00:00:09Z",
    );
  });

  test("carries a tool part's created_at forward when the streamed copy lacks it", () => {
    // Durable (DB-loaded) copy has the per-part fire time; the streamed replay
    // that upserts over it does not — without preservation a late-attaching /
    // reconnecting client loses the bash-sleep countdown anchor.
    const durable = {
      id: "m1",
      role: "assistant",
      created_at: "2026-01-01T00:00:00Z",
      parts: [
        {
          type: "tool-bash",
          toolCallId: "tc1",
          state: "input-available",
          created_at: "2026-01-01T00:00:05Z",
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: test helper
    } as any;
    const streamed = {
      id: "m1",
      role: "assistant",
      parts: [
        { type: "tool-bash", toolCallId: "tc1", state: "input-available" },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: test helper
    } as any;
    const out = upsertById([durable], streamed);
    expect((out[0]!.parts[0] as { created_at?: unknown }).created_at).toBe(
      "2026-01-01T00:00:05Z",
    );
  });
});

describe("dropRedundantStubs", () => {
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  const assistantMsg = (id: string, parts: any[] = []) =>
    ({
      id,
      role: "assistant",
      parts,
      created_at: "2026-01-01T00:00:00Z",
      // biome-ignore lint/suspicious/noExplicitAny: test helper
    }) as any;
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  const userMsg = { id: "u1", role: "user", parts: [] } as any;
  const TC = "tc_abc";

  const stub = assistantMsg("msg_async_stub_" + TC, [
    { type: "tool-web_search", toolCallId: TC, state: "input-available" },
  ]);
  const live = assistantMsg("msg_live", [
    { type: "tool-web_search", toolCallId: TC, state: "output-available" },
    { type: "text", text: "answer" },
  ]);

  test("drops stub when a live assistant message covers the toolCallId", () => {
    const out = dropRedundantStubs([userMsg, stub, live]);
    expect(out.map((m) => m.id)).toEqual(["u1", "msg_live"]);
  });

  test("keeps stub when no live message covers its toolCallId", () => {
    const out = dropRedundantStubs([userMsg, stub]);
    expect(out.map((m) => m.id)).toEqual(["u1", "msg_async_stub_" + TC]);
  });

  test("keeps stub when the live message covers a DIFFERENT toolCallId", () => {
    const otherLive = assistantMsg("msg_live2", [
      {
        type: "tool-web_search",
        toolCallId: "tc_other",
        state: "input-available",
      },
    ]);
    const out = dropRedundantStubs([userMsg, stub, otherLive]);
    expect(out.map((m) => m.id).sort()).toEqual(
      ["msg_async_stub_" + TC, "msg_live2", "u1"].sort(),
    );
  });

  test("drops a stub whose message-id suffix differs from its part toolCallId", () => {
    // Legacy stubs were keyed by a hashed id (`msg_async_stub_sha256:…`) while
    // their part carried the full toolCallId. Match by the part, not the suffix.
    const hashedStub = assistantMsg("msg_async_stub_sha256:deadbeef", [
      { type: "tool-web_search", toolCallId: TC, state: "input-available" },
    ]);
    const out = dropRedundantStubs([userMsg, hashedStub, live]);
    expect(out.map((m) => m.id)).toEqual(["u1", "msg_live"]);
  });

  test("noop when there are no stubs (cheap fast path)", () => {
    const out = dropRedundantStubs([userMsg, live]);
    expect(out).toBe(out); // (sanity that it returns a list)
    expect(out.map((m) => m.id)).toEqual(["u1", "msg_live"]);
  });

  test("mergeAndSort applies the dedup automatically", () => {
    // Production scenario: refetch returns the persisted stub; the
    // in-memory live message has the same tool-web_search part from
    // the prior connection's fold. After mergeAndSort the stub is gone.
    const out = mergeAndSort([live], [stub]);
    expect(out.map((m) => m.id)).toEqual(["msg_live"]);
  });
});

// ─── boot buffering ──────────────────────────────────────────────────────────

describe("boot buffering", () => {
  test("hasMoreOlder and isFetchingOlder stores exist and default to false", () => {
    globalThis.fetch = makeFetchMock() as unknown as typeof globalThis.fetch;
    const conn = getOrOpenStream("acme", "thread-stores", { client: null });
    expect(conn.hasMoreOlder.get()).toBe(false);
    expect(conn.isFetchingOlder.get()).toBe(false);
  });

  /** Build a mock MCP client whose `callTool(COLLECTION_THREAD_MESSAGES_LIST)`
   *  resolves on a controllable promise. */
  function makeControllableClient(): {
    client: {
      callTool: (req: { name: string; arguments: unknown }) => Promise<unknown>;
    };
    resolve: (items: unknown[], hasMore?: boolean) => void;
    reject: (err: Error) => void;
    calls: Array<{ name: string; arguments: unknown }>;
  } {
    const calls: Array<{ name: string; arguments: unknown }> = [];
    let resolveFn: ((value: unknown) => void) | null = null;
    let rejectFn: ((err: Error) => void) | null = null;
    const client = {
      callTool: (req: { name: string; arguments: unknown }) => {
        calls.push(req);
        return new Promise<unknown>((res, rej) => {
          resolveFn = res;
          rejectFn = rej;
        });
      },
    };
    return {
      client,
      resolve: (items: unknown[], hasMore = false) =>
        resolveFn?.({ structuredContent: { items, hasMore } }),
      reject: (err: Error) => rejectFn?.(err),
      calls,
    };
  }

  test("chunks arriving before initial page resolves are buffered, then drained", async () => {
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
    }) as unknown as typeof globalThis.fetch;

    const ctrl = makeControllableClient();
    const conn = getOrOpenStream("acme", "thread-buffer", {
      client: ctrl.client as never,
    });

    await new Promise((r) => setTimeout(r, 10));
    stream.enqueue({ type: "start", messageId: "m-live" });
    stream.enqueue({ type: "text-start", id: "p-1" });
    stream.enqueue({ type: "text-delta", id: "p-1", delta: "live" });
    stream.enqueue({ type: "text-end", id: "p-1" });
    stream.enqueue({ type: "finish", finishReason: "stop" });
    await new Promise((r) => setTimeout(r, 10));

    // Initial page hasn't resolved — messages must be empty so far.
    expect(conn.messages.get()).toEqual([]);
    expect(conn.status.get()).toEqual({ kind: "loading" });

    // Resolve the initial page with one persisted message (older than live).
    ctrl.resolve([
      {
        id: "m-persisted",
        role: "user",
        parts: [{ type: "text", text: "earlier" }],
        created_at: "2026-01-01T00:00:00Z",
      },
    ]);
    await new Promise((r) => setTimeout(r, 20));

    // Assert the MCP call shape so a regression in argument shape is caught.
    expect(ctrl.calls).toHaveLength(1);
    expect(ctrl.calls[0]?.name).toBe("COLLECTION_THREAD_MESSAGES_LIST");
    expect(ctrl.calls[0]?.arguments).toEqual({
      thread_id: "thread-buffer",
      limit: 5,
      offset: 0,
      orderBy: [{ field: ["created_at"], direction: "desc" }],
    });

    // Both the persisted message AND the live-folded assistant message are
    // present, ordered by timestamp.
    expect(conn.status.get()).toEqual({ kind: "ready" });
    const ids = conn.messages.get().map((m) => m.id);
    expect(ids).toEqual(["m-persisted", "m-live"]);
  });

  test("null MCP client → status flips to ready immediately, chunks fold live", async () => {
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-no-client", { client: null });
    await new Promise((r) => setTimeout(r, 20));

    expect(conn.status.get()).toEqual({ kind: "ready" });
    expect(conn.messages.get()).toEqual([]);

    stream.enqueue({ type: "start", messageId: "m-1" });
    stream.enqueue({ type: "text-start", id: "p-1" });
    stream.enqueue({ type: "text-delta", id: "p-1", delta: "hi" });
    stream.enqueue({ type: "text-end", id: "p-1" });
    stream.enqueue({ type: "finish", finishReason: "stop" });
    await new Promise((r) => setTimeout(r, 10));

    expect(conn.messages.get().at(-1)?.id).toBe("m-1");
  });

  test("initial-page error sets status=error", async () => {
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
    }) as unknown as typeof globalThis.fetch;

    const ctrl = makeControllableClient();
    const conn = getOrOpenStream("acme", "thread-page-err", {
      client: ctrl.client as never,
    });
    await new Promise((r) => setTimeout(r, 10));
    ctrl.reject(new Error("boom"));
    await new Promise((r) => setTimeout(r, 20));

    expect(conn.status.get().kind).toBe("error");
  });

  // G3 regression test: live SSE chunks that arrive while loadInitialPage is
  // in-flight must NOT get stuck in the buffer when loadInitialPage fails.
  // Previously the catch branch called failTo() without draining chunkBuffer,
  // so handleChunk kept buffering indefinitely and the chunks were never folded.
  test("G3: initial-page error drains chunk buffer so live chunks are rendered", async () => {
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
    }) as unknown as typeof globalThis.fetch;

    const ctrl = makeControllableClient();
    const conn = getOrOpenStream("acme", "thread-g3-drain", {
      client: ctrl.client as never,
    });

    // Wait for loadInitialPage to reach the MCP callTool (and for SSE to open).
    await new Promise((r) => setTimeout(r, 10));

    // Live chunks arrive while the initial page is still pending.
    stream.enqueue({ type: "start", messageId: "m-live-g3" });
    stream.enqueue({ type: "text-start", id: "p-g3" });
    stream.enqueue({ type: "text-delta", id: "p-g3", delta: "live content" });
    stream.enqueue({ type: "text-end", id: "p-g3" });
    stream.enqueue({ type: "finish", finishReason: "stop" });
    await new Promise((r) => setTimeout(r, 10));

    // Status is still loading — the page hasn't resolved yet, chunks are buffered.
    expect(conn.status.get().kind).toBe("loading");

    // Initial page FAILS.
    ctrl.reject(new Error("MCP load failed"));
    await new Promise((r) => setTimeout(r, 30));

    // The buffer must have been drained: the live chunks folded into messages
    // and the assistant message is visible despite the initial-page failure.
    const ids = conn.messages.get().map((m) => m.id);
    expect(ids).toContain("m-live-g3");
  });

  test("a stray non-chunk SSE event is silently ignored", async () => {
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
    }) as unknown as typeof globalThis.fetch;

    const ctrl = makeControllableClient();
    const conn = getOrOpenStream("acme", "thread-stray-snapshot", {
      client: ctrl.client as never,
    });

    // Yield enough microtasks for loadInitialPage to reach callTool, then
    // resolve the initial page with an empty list.
    await new Promise((r) => setTimeout(r, 10));
    ctrl.resolve([]);
    await new Promise((r) => setTimeout(r, 50));
    expect(conn.messages.get()).toEqual([]);

    // Send real chunks — these should fold normally. The test name + the
    // chunk-only path together guard against a regression where the
    // snapshot branch returns and silently consumes legitimate chunks.
    stream.enqueue({ type: "start", messageId: "real" });
    stream.enqueue({ type: "text-start", id: "p-real" });
    stream.enqueue({ type: "text-delta", id: "p-real", delta: "hi" });
    stream.enqueue({ type: "text-end", id: "p-real" });
    stream.enqueue({ type: "finish", finishReason: "stop" });
    await new Promise((r) => setTimeout(r, 50));

    const ids = conn.messages.get().map((m) => m.id);
    expect(ids).toEqual(["real"]);
  });
});

// ─── fetchOlderMessages ──────────────────────────────────────────────────────

describe("fetchOlderMessages", () => {
  function makeQueuedClient(
    pages: Array<{ items: unknown[]; hasMore: boolean }>,
  ) {
    const calls: Array<{ name: string; arguments: unknown }> = [];
    let cursor = 0;
    return {
      calls,
      client: {
        callTool: async (req: { name: string; arguments: unknown }) => {
          calls.push(req);
          const page = pages[cursor++];
          if (!page)
            return { structuredContent: { items: [], hasMore: false } };
          return { structuredContent: page };
        },
      },
    };
  }

  test("loads next older page and increments serverFetchedCount", async () => {
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
    }) as unknown as typeof globalThis.fetch;

    const pages = [
      // initial page (newest 5, desc; mergeAndSort flips to ascending in store)
      {
        items: [
          {
            id: "m-5",
            role: "user",
            parts: [],
            created_at: "2026-01-01T00:00:05Z",
          },
          {
            id: "m-4",
            role: "user",
            parts: [],
            created_at: "2026-01-01T00:00:04Z",
          },
          {
            id: "m-3",
            role: "user",
            parts: [],
            created_at: "2026-01-01T00:00:03Z",
          },
          {
            id: "m-2",
            role: "user",
            parts: [],
            created_at: "2026-01-01T00:00:02Z",
          },
          {
            id: "m-1",
            role: "user",
            parts: [],
            created_at: "2026-01-01T00:00:01Z",
          },
        ],
        hasMore: true,
      },
      // older page
      {
        items: [
          {
            id: "m-0",
            role: "user",
            parts: [],
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
        hasMore: false,
      },
    ];
    const harness = makeQueuedClient(pages);
    const conn = getOrOpenStream("acme", "thread-fetch-older", {
      client: harness.client as never,
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(conn.hasMoreOlder.get()).toBe(true);
    expect(conn.messages.get()).toHaveLength(5);

    await conn.fetchOlderMessages();

    expect(conn.messages.get().map((m) => m.id)).toEqual([
      "m-0",
      "m-1",
      "m-2",
      "m-3",
      "m-4",
      "m-5",
    ]);
    expect(conn.hasMoreOlder.get()).toBe(false);

    // Second call short-circuits because hasMoreOlder is now false — no extra MCP call.
    await conn.fetchOlderMessages();
    expect(harness.calls.length).toBe(2);
  });

  test("guards against concurrent calls via isFetchingOlder", async () => {
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
    }) as unknown as typeof globalThis.fetch;

    // biome-ignore lint/style/useConst: assigned inside a closure
    let resolveSecond: ((value: unknown) => void) | null = null;
    let callIdx = 0;
    const client = {
      callTool: (_req: unknown) => {
        callIdx++;
        if (callIdx === 1) {
          // initial page
          return Promise.resolve({
            structuredContent: {
              items: Array.from({ length: 5 }, (_, i) => ({
                id: `m-${i}`,
                role: "user",
                parts: [],
                created_at: `2026-01-01T00:00:0${i}Z`,
              })),
              hasMore: true,
            },
          });
        }
        // older page — controllable
        return new Promise((res) => {
          resolveSecond = res;
        });
      },
    };

    const conn = getOrOpenStream("acme", "thread-fetch-guard", {
      client: client as never,
    });
    await new Promise((r) => setTimeout(r, 20));

    const p1 = conn.fetchOlderMessages();
    // Second call must short-circuit while the first is in flight.
    expect(conn.isFetchingOlder.get()).toBe(true);
    const p2 = conn.fetchOlderMessages();
    await p2; // resolves immediately because of the guard

    expect(callIdx).toBe(2); // only first older-page call was issued

    // biome-ignore lint/style/noNonNullAssertion: assigned by the closure above
    resolveSecond!({ structuredContent: { items: [], hasMore: false } });
    await p1;
    expect(conn.isFetchingOlder.get()).toBe(false);
  });
});

// ─── reconnect refetch ───────────────────────────────────────────────────────

describe("reconnect refetch", () => {
  test("re-fetches latest page on SSE reconnect and merges via upsert", async () => {
    let streamSlot = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => streamSlot.response,
    }) as unknown as typeof globalThis.fetch;

    const calls: Array<{ name: string; arguments: unknown }> = [];
    let nextResolve: ((items: unknown[]) => void) | null = null;
    const client = {
      callTool: (req: { name: string; arguments: unknown }) => {
        calls.push(req);
        return new Promise<unknown>((res) => {
          nextResolve = (items: unknown[]) =>
            res({ structuredContent: { items, hasMore: false } });
        });
      },
    };

    const conn = getOrOpenStream("acme", "thread-reconnect", {
      client: client as never,
    });

    // Initial page resolves with one row.
    await new Promise((r) => setTimeout(r, 10));
    // biome-ignore lint/style/noNonNullAssertion: set by callTool closure above
    nextResolve!([
      {
        id: "m-1",
        role: "user",
        parts: [],
        created_at: "2026-01-01T00:00:00Z",
      },
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(conn.messages.get().map((m) => m.id)).toEqual(["m-1"]);
    expect(calls.length).toBe(1);

    // Force a reconnect by closing the current stream and providing a fresh one.
    streamSlot.close();
    streamSlot = controllableStream();
    // streamSlot.close() is a clean exit → CLEAN_RECONNECT_DELAY_MS (50ms);
    // 1100ms is overkill but stable for test scheduling.
    await new Promise((r) => setTimeout(r, 1100));

    // After reconnect, refetchLatestPage must have fired a second call.
    expect(calls.length).toBe(2);

    // Resolve with a newer row that arrived while disconnected.
    // biome-ignore lint/style/noNonNullAssertion: set by second callTool call
    nextResolve!([
      {
        id: "m-2",
        role: "user",
        parts: [],
        created_at: "2026-01-01T00:00:01Z",
      },
      {
        id: "m-1",
        role: "user",
        parts: [],
        created_at: "2026-01-01T00:00:00Z",
      },
    ]);
    await new Promise((r) => setTimeout(r, 20));

    // Both rows present, ordered ascending by created_at.
    expect(conn.messages.get().map((m) => m.id)).toEqual(["m-1", "m-2"]);
  });
});
