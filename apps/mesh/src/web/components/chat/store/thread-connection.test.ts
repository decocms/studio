import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  __resetRegistry,
  dropRedundantStubs,
  getOrOpenStream,
  mergeAndSort,
  type RequestOptions,
  type ThreadObserver,
} from "./thread-connection";
import type { UIMessage } from "ai";

// ─── Fetch mock builders ─────────────────────────────────────────────────────

/** Build a fetch mock with explicit handlers per endpoint. Default: /messages
 *  200s; /stream hangs until aborted. Each endpoint can be overridden. */
function makeFetchMock(
  opts: {
    stream?: (init?: RequestInit) => Response | Promise<Response>;
    messages?: (init?: RequestInit) => Response;
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

  test("single approval, accept → POSTs once", async () => {
    let messagesCalls = 0;
    const stream = controllableStream();
    globalThis.fetch = makeFetchMock({
      stream: () => stream.response,
      messages: () => {
        messagesCalls++;
        return new Response("ok", { status: 200 });
      },
    }) as unknown as typeof globalThis.fetch;

    const conn = getOrOpenStream("acme", "thread-single-appr", {
      client: null,
    });
    await new Promise((r) => setTimeout(r, 20));
    await stageTurn(stream, { approvalIds: ["a1"] });

    await conn.submit(
      { kind: "approval", approvalId: "a1", approved: true },
      baseOpts,
    );

    expect(messagesCalls).toBe(1);
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

  test("metadata.created_at is ignored — only top-level created_at is used", () => {
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

// ─── async-research stub dedup ───────────────────────────────────────────────

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
