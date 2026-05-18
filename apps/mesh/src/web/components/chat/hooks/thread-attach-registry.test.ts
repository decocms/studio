import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  __resetRegistry,
  getOrOpenAttach,
  type ThreadObserver,
} from "./thread-attach-registry";

// Minimal EventSource stub — the registry wires up the SSE backstop but the
// tests don't exercise the SSE path, so a no-op implementation is enough.
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = FakeEventSource.OPEN;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener() {}
  removeEventListener() {}
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

/** Build a fetch mock that streams a complete `start..finish` run on the
 *  first call, then hangs subsequent calls (so runPersistentLoop's reconnect
 *  doesn't spin during the test). */
function makeStreamingFetchMock(textDelta = "hi"): ReturnType<typeof mock> {
  let callCount = 0;
  return mock((_input: RequestInfo | URL, init?: RequestInit) => {
    callCount++;
    if (callCount === 1) {
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(c) {
              const enc = new TextEncoder();
              const lines = [
                `data: ${JSON.stringify({ type: "start", messageId: "m-1" })}\n\n`,
                `data: ${JSON.stringify({ type: "text-start", id: "p-1" })}\n\n`,
                `data: ${JSON.stringify({ type: "text-delta", id: "p-1", delta: textDelta })}\n\n`,
                `data: ${JSON.stringify({ type: "text-end", id: "p-1" })}\n\n`,
                `data: ${JSON.stringify({ type: "finish", finishReason: "stop" })}\n\n`,
              ];
              for (const l of lines) c.enqueue(enc.encode(l));
              c.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    }
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
  });
}

/** Build a fetch mock that opens a controllable stream SSE and ACKs
 *  POSTs to /messages. Returns helpers to enqueue chunks at test time. */
function makeControlledAttachMock(): {
  fetchMock: ReturnType<typeof mock>;
  enqueue: (chunk: unknown) => void;
  closeAttach: () => void;
} {
  let attachController: ReadableStreamDefaultController<Uint8Array> | null =
    null;
  const enc = new TextEncoder();
  const enqueue = (chunk: unknown) => {
    if (!attachController) throw new Error("stream SSE not open");
    attachController.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  };
  const closeAttach = () => {
    attachController?.close();
    attachController = null;
  };
  const fetchMock = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/stream")) {
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              attachController = c;
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    }
    if (url.includes("/messages")) {
      return Promise.resolve(new Response("ok", { status: 200 }));
    }
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
  });
  return { fetchMock, enqueue, closeAttach };
}

/** Build a fetch mock where every call hangs until aborted. */
function makeHangingFetchMock(): ReturnType<typeof mock> {
  return mock(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  );
}

describe("getOrOpenAttach", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEventSource: typeof globalThis.EventSource;
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    __resetRegistry();
    originalFetch = globalThis.fetch;
    originalEventSource = globalThis.EventSource;
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    fetchMock = makeHangingFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    __resetRegistry();
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
  });

  test("returns the same instance for the same key", () => {
    const a = getOrOpenAttach("acme", "thread-1");
    const b = getOrOpenAttach("acme", "thread-1");
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("disposes the prior connection when key changes", () => {
    const a = getOrOpenAttach("acme", "thread-1");
    const aAbortSpy = mock(() => {});
    a.abort.signal.addEventListener("abort", aAbortSpy);

    const b = getOrOpenAttach("acme", "thread-2");

    expect(a).not.toBe(b);
    expect(aAbortSpy).toHaveBeenCalledTimes(1);
    expect(a.abort.signal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("returning to a previous key opens a fresh connection", () => {
    const a = getOrOpenAttach("acme", "thread-1");
    getOrOpenAttach("acme", "thread-2");
    const a2 = getOrOpenAttach("acme", "thread-1");

    expect(a2).not.toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("chunk handling", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEventSource: typeof globalThis.EventSource;

  beforeEach(() => {
    __resetRegistry();
    originalFetch = globalThis.fetch;
    originalEventSource = globalThis.EventSource;
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    globalThis.fetch =
      makeStreamingFetchMock() as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    __resetRegistry();
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
  });

  test("folds a complete run into localMessages and resets streaming", async () => {
    const conn = getOrOpenAttach("acme", "thread-x");
    await new Promise((r) => setTimeout(r, 500));
    expect(conn.streaming.get()).toBe(null);
    const msgs = conn.localMessages.get();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe("assistant");
    expect(conn.status.get()).toBe("ready");
  });

  test("the assigned observer receives onFinish; reassignment replaces", async () => {
    const conn = getOrOpenAttach("acme", "thread-y");
    const finishA = mock(() => {});
    const observerA: ThreadObserver = { onFinish: finishA };
    conn.observer = observerA;

    await new Promise((r) => setTimeout(r, 500));

    expect(finishA).toHaveBeenCalledTimes(1);

    // Reassigning the slot replaces. A second observer set after the run
    // doesn't retroactively receive past events.
    const finishB = mock(() => {});
    conn.observer = { onFinish: finishB };
    expect(finishB).toHaveBeenCalledTimes(0);
  });
});

describe("tool approval resume", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEventSource: typeof globalThis.EventSource;
  let ctrl: ReturnType<typeof makeControlledAttachMock>;

  beforeEach(() => {
    __resetRegistry();
    originalFetch = globalThis.fetch;
    originalEventSource = globalThis.EventSource;
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    ctrl = makeControlledAttachMock();
    globalThis.fetch = ctrl.fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    __resetRegistry();
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
  });

  test("resume run after approval can resolve tool output without No-tool-invocation error", async () => {
    const conn = getOrOpenAttach("acme", "thread-resume");
    conn.context = { initialMessages: [] };

    const errors: Error[] = [];
    const observer: ThreadObserver = {
      onError: (e) => errors.push(e),
    };
    conn.observer = observer;

    // Wait for the /stream fetch to be issued + body wired up.
    await new Promise((r) => setTimeout(r, 0));

    // Run #1: assistant emits a tool call that needs approval, then pauses.
    ctrl.enqueue({ type: "start", messageId: "msg-1" });
    ctrl.enqueue({ type: "start-step" });
    ctrl.enqueue({
      type: "tool-input-start",
      toolCallId: "toolu_TEST",
      toolName: "fs_write",
    });
    ctrl.enqueue({
      type: "tool-input-available",
      toolCallId: "toolu_TEST",
      toolName: "fs_write",
      input: { path: "/tmp/x" },
    });
    ctrl.enqueue({
      type: "tool-approval-request",
      toolCallId: "toolu_TEST",
      approvalId: "appr_1",
    });
    ctrl.enqueue({ type: "finish-step" });
    ctrl.enqueue({ type: "finish", finishReason: "tool-calls" });

    // Let the fold loop drain.
    await new Promise((r) => setTimeout(r, 10));

    // Approve. This triggers a POST to /messages and maybeAutoSend.
    conn.addToolApprovalResponse(
      { id: "appr_1", approved: true },
      {
        tier: "standard" as never,
        mode: "chat" as never,
        toolApprovalLevel: "readonly",
      },
    );

    await new Promise((r) => setTimeout(r, 10));

    // Run #2: server resumes the tool and emits output on the SAME stream SSE.
    ctrl.enqueue({ type: "start", messageId: "msg-1" });
    ctrl.enqueue({ type: "start-step" });
    ctrl.enqueue({
      type: "tool-output-available",
      toolCallId: "toolu_TEST",
      output: { ok: true },
    });
    ctrl.enqueue({ type: "finish-step" });
    ctrl.enqueue({ type: "finish", finishReason: "stop" });

    await new Promise((r) => setTimeout(r, 10));

    // No SDK error captured.
    const sdkErr = errors.find((e) =>
      /No tool invocation found for tool call ID/.test(e.message),
    );
    expect(sdkErr).toBeUndefined();

    // Final message has the tool output resolved.
    const final = conn.snapshotAll().at(-1);
    expect(final?.role).toBe("assistant");
    const toolPart = final?.parts.find(
      (p) => (p as { toolCallId?: string }).toolCallId === "toolu_TEST",
    ) as { state?: string; output?: unknown } | undefined;
    expect(toolPart?.state).toBe("output-available");
    expect(toolPart?.output).toEqual({ ok: true });
  });

  test("server replay on reconnect does not duplicate tool parts", async () => {
    // Two-shot fetch: first stream closes after finish(tool-calls); the
    // reconnect attempt opens a second controllable stream that replays the
    // same run, then hangs.
    let openCount = 0;
    let liveController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    const enc = new TextEncoder();
    const enqueue = (chunk: unknown) => {
      if (!liveController) throw new Error("no stream open");
      liveController.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    };
    const closeLive = () => {
      liveController?.close();
      liveController = null;
    };
    const fetchMock = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/stream")) {
        openCount++;
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                liveController = c;
              },
            }),
            {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            },
          ),
        );
      }
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const conn = getOrOpenAttach("acme", "thread-replay");
    conn.context = { initialMessages: [] };

    await new Promise((r) => setTimeout(r, 0));

    // Run #1
    enqueue({ type: "start", messageId: "msg-1" });
    enqueue({
      type: "tool-input-available",
      toolCallId: "toolu_R",
      toolName: "fs_read",
      input: { path: "/a" },
    });
    enqueue({
      type: "tool-approval-request",
      toolCallId: "toolu_R",
      approvalId: "appr_R",
    });
    enqueue({ type: "finish", finishReason: "tool-calls" });
    await new Promise((r) => setTimeout(r, 10));

    // Close the stream to simulate the SSE clean-exit -> reconnect path.
    closeLive();
    // Wait for the reconnect loop to issue the second stream fetch.
    await new Promise((r) => setTimeout(r, 30));
    expect(openCount).toBe(2);

    // Replay of the same run.
    enqueue({ type: "start", messageId: "msg-1" });
    enqueue({
      type: "tool-input-available",
      toolCallId: "toolu_R",
      toolName: "fs_read",
      input: { path: "/a" },
    });
    enqueue({
      type: "tool-approval-request",
      toolCallId: "toolu_R",
      approvalId: "appr_R",
    });
    enqueue({ type: "finish", finishReason: "tool-calls" });
    await new Promise((r) => setTimeout(r, 10));

    // Exactly one assistant message in the snapshot, with exactly one tool
    // part for `toolu_R`.
    const all = conn.snapshotAll();
    const assistants = all.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(1);
    const firstAssistant = assistants[0];
    if (!firstAssistant) throw new Error("expected an assistant message");
    const toolParts = firstAssistant.parts.filter(
      (p) => (p as { toolCallId?: string }).toolCallId === "toolu_R",
    );
    expect(toolParts.length).toBe(1);
  });

  test("plain text turn with finishReason=stop flushes to localMessages and clears streaming", async () => {
    const conn = getOrOpenAttach("acme", "thread-plain");
    conn.context = { initialMessages: [] };
    await new Promise((r) => setTimeout(r, 0));

    ctrl.enqueue({ type: "start", messageId: "msg-plain" });
    ctrl.enqueue({ type: "text-start", id: "t-1" });
    ctrl.enqueue({ type: "text-delta", id: "t-1", delta: "hello" });
    ctrl.enqueue({ type: "text-end", id: "t-1" });
    ctrl.enqueue({ type: "finish", finishReason: "stop" });

    await new Promise((r) => setTimeout(r, 10));

    expect(conn.streaming.get()).toBeNull();
    const all = conn.snapshotAll();
    expect(all.length).toBe(1);
    expect(all[0]?.role).toBe("assistant");
  });

  test("snapshotAll dedupes streaming against initialMessages (server-wins)", async () => {
    const conn = getOrOpenAttach("acme", "thread-dedup");
    conn.context = { initialMessages: [] };
    await new Promise((r) => setTimeout(r, 0));

    // Resumable run leaves the assistant message in `streaming`.
    ctrl.enqueue({ type: "start", messageId: "msg-dup" });
    ctrl.enqueue({
      type: "tool-input-available",
      toolCallId: "toolu_D",
      toolName: "fs_read",
      input: { path: "/a" },
    });
    ctrl.enqueue({
      type: "tool-approval-request",
      toolCallId: "toolu_D",
      approvalId: "appr_D",
    });
    ctrl.enqueue({ type: "finish", finishReason: "tool-calls" });
    await new Promise((r) => setTimeout(r, 10));

    expect(conn.streaming.get()?.id).toBe("msg-dup");

    // Simulate THREAD_MESSAGES refetch landing while `streaming` still holds
    // the paused assistant message — initialMessages now also contains it.
    const serverEcho = conn.streaming.get();
    if (!serverEcho) throw new Error("expected streaming to be set");
    conn.context = {
      initialMessages: [
        { ...serverEcho, parts: [...serverEcho.parts] } as never,
      ],
    };

    const all = conn.snapshotAll();
    const ids = all.map((m) => m.id);
    expect(ids).toEqual(["msg-dup"]);
  });
});
