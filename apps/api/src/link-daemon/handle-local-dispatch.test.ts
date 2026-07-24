/**
 * Unit tests for handleLocalDispatch.
 *
 * The sandbox `/_sandbox/dispatch` leg is driven by a stub `fetchImpl` — no
 * real HTTP. The cluster chunk relay and the synthesized failure relay publish
 * directly to JetStream; tests inject a fake `relayPublisher` and assert on the
 * recorded lines/dones instead of hitting NATS. No real NATS, no DB.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UIMessageChunk } from "ai";
import type { WorkItem } from "../links/link-work-item";
import type { RelayLine } from "../links/protocol/relay";
import {
  handleLocalDispatch,
  type LocalDispatchDeps,
  relayWorkItemFailure,
} from "./handle-local-dispatch";
import { openInMemoryOutbox, openOutbox } from "./outbox";

// ── Fixtures ────────────────────────────────────────────────────────────────

const SANDBOX_BASE = "http://127.0.0.1:9123";
const ORG_SLUG = "acme";
const DAEMON_TOKEN = "daemon-tok-abc";
const FENCE_TOKEN = "fence-tok-123";
const RUN_ID = "run_01";

/** A minimal valid WorkItem fixture. */
const validWorkItem: WorkItem = {
  runId: RUN_ID,
  threadId: "thrd_01",
  orgId: "org_01",
  userId: "usr_01",
  runFenceToken: FENCE_TOKEN,
  orgSlug: ORG_SLUG,
  harnessInput: {
    threadId: "thrd_01",
    runId: RUN_ID,
    taskId: "task_01",
    messages: [],
    workspace: { cwd: "default" },
    models: {
      thinking: {
        id: "claude-3-7-sonnet",
        title: "Sonnet",
        credentialId: "cred_01",
      },
    },
    mcp: {
      url: "https://mcp.example.com",
      headers: {},
      expiresAt: 9_999_999_999,
    },
    mode: "auto",
    temperature: 0,
    toolApprovalLevel: "auto",
    user: { id: "usr_01", email: "user@example.com" },
    organizationId: "org_01",
    virtualMcp: {},
    agent: { id: "claude-code" },
  },
};

/** A throwaway NatsConnection — the fake publisher means it's never used. */
const FAKE_NC = {} as unknown as import("@nats-io/nats-core").NatsConnection;

/** Minimal SSE payload the local sandbox would return. */
const FAKE_SSE_BODY = `data: {"type":"done"}\n\n`;

const TEXT_CHUNKS = [
  { type: "start" },
  { type: "start-step" },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "hello" },
  { type: "text-end", id: "t1" },
  { type: "finish-step" },
  { type: "finish" },
] as UIMessageChunk[];

type RecordedLine = { runId: string; fenceToken: string; line: RelayLine };
type RecordedDone = { runId: string; fenceToken: string; finalSeq: number };

/**
 * A fake DirectNatsPublisher that records every published line and done. The
 * `lines` array is the relayed prefix (in seq order); `dones` is the terminal
 * `done` markers with their `finalSeq`. This is the test seam used everywhere a
 * relay path would otherwise hit JetStream.
 */
function fakePublisher() {
  const lines: RecordedLine[] = [];
  const dones: RecordedDone[] = [];
  const publisher = {
    publishLine: async (i: RecordedLine) => {
      lines.push(i);
      return (i.line.event.type === "done" ? "terminal" : "published") as
        | "published"
        | "terminal";
    },
    publishDone: async (i: RecordedDone) => {
      dones.push(i);
    },
  };
  return { publisher, lines, dones };
}

/**
 * Build a fake ReadableStream from a string, for simulating the sandbox SSE
 * response body.
 */
function makeBodyStream(content: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const chunk = enc.encode(content);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
}

function dispatchSSE(chunks: UIMessageChunk[]): string {
  return `${chunks
    .map(
      (chunk) =>
        `data: ${JSON.stringify({ type: "ui-message-chunk", chunk })}\n\n`,
    )
    .join("")}data: {"type":"done"}\n\n`;
}

// ── Test: successful relay ──────────────────────────────────────────────────

describe("handleLocalDispatch", () => {
  it("POSTs to sandbox dispatch and publishes seq-numbered relay lines to NATS", async () => {
    const fp = fakePublisher();
    const capturedRequests: Array<{ url: string; init: RequestInit }> = [];

    const fetchImpl = async (
      url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedRequests.push({ url, init: init ?? {} });

      if (url.includes("/_sandbox/dispatch")) {
        // Sandbox dispatch: return 200 with a fake SSE stream body.
        return new Response(makeBodyStream(dispatchSSE(TEXT_CHUNKS)), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }

      throw new Error(`Unexpected fetch to ${url}`);
    };

    const deps: LocalDispatchDeps = {
      outbox: openInMemoryOutbox(),
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getNatsConnection: () => FAKE_NC,
      relayPublisher: fp.publisher,
    };

    await handleLocalDispatch(validWorkItem, deps);

    // ── Assert sandbox dispatch call ────────────────────────────────────────
    const dispatchCall = capturedRequests.find((r) =>
      r.url.includes("/_sandbox/dispatch"),
    );
    expect(dispatchCall).toBeDefined();
    expect(dispatchCall!.url).toBe(`${SANDBOX_BASE}/_sandbox/dispatch`);
    const dispatchHeaders = dispatchCall!.init.headers as Record<
      string,
      string
    >;
    expect(dispatchHeaders.authorization).toBe(`Bearer ${DAEMON_TOKEN}`);
    expect(dispatchHeaders["content-type"]).toBe("application/json");
    expect(dispatchHeaders.accept).toBe("text/event-stream");
    // Bun's fetch default-times-out a long-lived stream; the harness SSE can
    // idle for minutes (slow tool call / deep reasoning), so the read would trip
    // `TimeoutError: The operation timed out` and the run dies as
    // `local_dispatch_failed`. The loopback dispatch MUST disable it.
    expect((dispatchCall!.init as { timeout?: boolean }).timeout).toBe(false);

    // Verify the dispatch body shape: { harnessId, input }
    const dispatchBodyStr = dispatchCall!.init.body as string;
    const dispatchBody = JSON.parse(dispatchBodyStr) as {
      harnessId: string;
      input: Record<string, unknown>;
    };
    expect(typeof dispatchBody.harnessId).toBe("string");
    expect(dispatchBody.harnessId).toBe("claude-code"); // derived from agent.id
    expect(dispatchBody.input).toEqual(validWorkItem.harnessInput);

    // ── The relay leg no longer hits HTTP — assert only the dispatch leg did ─
    expect(
      capturedRequests.filter((r) => r.url.includes("/links/runs/")),
    ).toHaveLength(0);

    // ── Assert the relay lines published to NATS, in seq order ──────────────
    expect(fp.lines.map((l) => l.line.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const l of fp.lines) {
      expect(l.runId).toBe(RUN_ID);
      expect(l.fenceToken).toBe(FENCE_TOKEN);
    }
    expect(fp.lines.slice(0, 7).map((l) => l.line.event)).toEqual(
      TEXT_CHUNKS.map((chunk) => ({ type: "ui-message-chunk", chunk })),
    );
    expect(fp.lines.at(-1)!.line.event).toEqual({ type: "done" });

    // ── Assert the terminal done was published with the content finalSeq ────
    expect(fp.dones).toHaveLength(1);
    expect(fp.dones[0]).toMatchObject({
      runId: RUN_ID,
      fenceToken: FENCE_TOKEN,
      finalSeq: 7,
    });
  });

  // ── Test: non-ok sandbox dispatch → throw ──────────────────────────────

  it("throws when the sandbox dispatch returns a non-2xx response", async () => {
    const fp = fakePublisher();
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("/_sandbox/dispatch")) {
        return new Response(JSON.stringify({ error: "unknown_harness" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const deps: LocalDispatchDeps = {
      outbox: openInMemoryOutbox(),
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getNatsConnection: () => FAKE_NC,
      relayPublisher: fp.publisher,
    };

    await expect(handleLocalDispatch(validWorkItem, deps)).rejects.toThrow(
      "[handleLocalDispatch] unknown_harness",
    );
    // Nothing was relayed — the dispatch never produced a stream.
    expect(fp.lines).toHaveLength(0);
    expect(fp.dones).toHaveLength(0);
  });

  it("throws when sandbox dispatch does not return response headers before the start timeout", async () => {
    const fp = fakePublisher();
    const fetchImpl = async (
      url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      if (url.includes("/_sandbox/dispatch")) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(signal.reason ?? new DOMException("aborted", "AbortError"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              reject(
                signal.reason ?? new DOMException("aborted", "AbortError"),
              );
            },
            { once: true },
          );
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const deps: LocalDispatchDeps = {
      outbox: openInMemoryOutbox(),
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dispatchStartTimeoutMs: 5,
      getNatsConnection: () => FAKE_NC,
      relayPublisher: fp.publisher,
    };

    await expect(handleLocalDispatch(validWorkItem, deps)).rejects.toThrow(
      "[handleLocalDispatch] dispatch start timed out after 5ms",
    );
    // Timed out before any stream arrived → nothing published.
    expect(fp.lines).toHaveLength(0);
    expect(fp.dones).toHaveLength(0);
  });

  // ── Test: a permanent (non-retriable) publish failure propagates ────────

  it("throws without retrying when the relay publish fails permanently", async () => {
    let publishAttempts = 0;

    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("/_sandbox/dispatch")) {
        return new Response(makeBodyStream(FAKE_SSE_BODY), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    // A publisher whose first line publish fails with a permanent (4xx-like)
    // error: chunk-relay's `isRetriable` treats `.status` in [400,500) as
    // non-retriable, so the relay must throw on the first attempt.
    const publisher = {
      publishLine: async () => {
        publishAttempts++;
        const err = new Error("permanent publish failure") as Error & {
          status?: number;
        };
        err.status = 409;
        throw err;
      },
      publishDone: async () => {},
    };

    const deps: LocalDispatchDeps = {
      outbox: openInMemoryOutbox(),
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getNatsConnection: () => FAKE_NC,
      relayPublisher: publisher,
    };

    await expect(handleLocalDispatch(validWorkItem, deps)).rejects.toThrow(
      "permanent publish failure",
    );
    // Permanent (non-retriable) → exactly one publish attempt.
    expect(publishAttempts).toBe(1);
  });

  // ── Test: transient relay failure → reconnect resends the full prefix ──

  it("retries a transient relay failure and resends the whole prefix from seq 1", async () => {
    let postAttempts = 0;
    const prefixes: number[][] = [];
    let current: number[] = [];

    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("/_sandbox/dispatch")) {
        return new Response(makeBodyStream(dispatchSSE(TEXT_CHUNKS)), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    // The first POST attempt fails transiently (no `.status` → retriable);
    // the second succeeds. Each attempt re-reads the durable prefix from seq 1,
    // so a `seq === 1` line marks a fresh attempt. We snapshot the prefix the
    // publisher actually drained per attempt.
    const failingPublisher = {
      publishLine: async (i: RecordedLine) => {
        if (i.line.seq === 1) {
          // A new attempt is beginning — bank the previous attempt's prefix.
          if (current.length > 0) prefixes.push(current);
          current = [];
          postAttempts++;
        }
        current.push(i.line.seq);
        // First attempt drops transiently (no `.status` → retriable).
        if (postAttempts === 1) throw new Error("transient publish drop");
        return (i.line.event.type === "done" ? "terminal" : "published") as
          | "published"
          | "terminal";
      },
      publishDone: async () => {
        // The successful attempt completed — bank its full prefix.
        prefixes.push(current);
        current = [];
      },
    };

    const deps: LocalDispatchDeps = {
      outbox: openInMemoryOutbox(),
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getNatsConnection: () => FAKE_NC,
      relayPublisher: failingPublisher,
      relayRetry: { maxAttempts: 3, minTimeout: 1, maxTimeout: 2, jitter: 0 },
    };

    await handleLocalDispatch(validWorkItem, deps);

    // Two POST attempts: the first dropped at seq 1, the second drained the
    // complete prefix (7 chunks + done) from seq 1.
    expect(postAttempts).toBe(2);
    expect(prefixes.at(-1)!).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  // ── Test: a session renewal mid-run recovers via per-attempt re-source ──

  it("recovers when the first publish attempt throws ClosedConnectionError (session renewal) and a retry succeeds", async () => {
    let postAttempts = 0;
    let current: number[] = [];
    const prefixes: number[][] = [];

    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("/_sandbox/dispatch")) {
        return new Response(makeBodyStream(dispatchSSE(TEXT_CHUNKS)), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    // Simulate a tunnel-session renewal: the FIRST post attempt's publish
    // throws a ClosedConnectionError (the pinned connection was recycled). It
    // has no `.status`, so chunk-relay treats it as retriable; the retry
    // re-sources the (now live) connection and drains the whole prefix again.
    const renewalPublisher = {
      publishLine: async (i: RecordedLine) => {
        if (i.line.seq === 1) {
          if (current.length > 0) prefixes.push(current);
          current = [];
          postAttempts++;
        }
        current.push(i.line.seq);
        if (postAttempts === 1) {
          // No `.status` → retriable, mirroring a real ClosedConnectionError.
          throw new Error("ClosedConnectionError: connection closed");
        }
        return (i.line.event.type === "done" ? "terminal" : "published") as
          | "published"
          | "terminal";
      },
      publishDone: async () => {
        prefixes.push(current);
        current = [];
      },
    };

    const deps: LocalDispatchDeps = {
      outbox: openInMemoryOutbox(),
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getNatsConnection: () => FAKE_NC,
      relayPublisher: renewalPublisher,
      relayRetry: { maxAttempts: 3, minTimeout: 1, maxTimeout: 2, jitter: 0 },
    };

    await handleLocalDispatch(validWorkItem, deps);

    // The renewal dropped attempt 1 at seq 1; the retry re-sent the full prefix
    // (7 chunks + done) from seq 1, so the run still relays everything.
    expect(postAttempts).toBe(2);
    expect(prefixes.at(-1)!).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  // ── Test: harnessId from explicit deps override ─────────────────────────

  it("uses deps.harnessId when explicitly provided", async () => {
    const fp = fakePublisher();
    let capturedDispatchBody: { harnessId: string } | null = null;

    const fetchImpl = async (
      url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      if (url.includes("/_sandbox/dispatch")) {
        capturedDispatchBody = JSON.parse(init?.body as string) as {
          harnessId: string;
        };
        return new Response(makeBodyStream(FAKE_SSE_BODY), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const deps: LocalDispatchDeps = {
      outbox: openInMemoryOutbox(),
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      harnessId: "codex",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getNatsConnection: () => FAKE_NC,
      relayPublisher: fp.publisher,
    };

    await handleLocalDispatch(validWorkItem, deps);
    expect(capturedDispatchBody!.harnessId).toBe("codex");
  });

  // ── Test: harnessId embedded in harnessInput takes priority over agent.id

  it("reads harnessId from harnessInput when agent.id is a virtual MCP id", async () => {
    const fp = fakePublisher();
    let capturedHarnessId: string | null = null;

    const fetchImpl = async (
      url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      if (url.includes("/_sandbox/dispatch")) {
        const body = JSON.parse(init?.body as string) as { harnessId: string };
        capturedHarnessId = body.harnessId;
        return new Response(makeBodyStream(FAKE_SSE_BODY), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const workWithEmbeddedHarnessId: WorkItem = {
      ...validWorkItem,
      harnessInput: {
        ...validWorkItem.harnessInput,
        agent: { id: "vmcp_123" },
        harnessId: "decopilot",
      },
    };

    const deps: LocalDispatchDeps = {
      outbox: openInMemoryOutbox(),
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getNatsConnection: () => FAKE_NC,
      relayPublisher: fp.publisher,
    };

    await handleLocalDispatch(workWithEmbeddedHarnessId, deps);
    // capturedHarnessId is mutated inside the async fetchImpl closure —
    // TypeScript does not narrow it; assert non-null explicitly.
    expect(capturedHarnessId!).toBe("decopilot");
  });

  // ── Test: messagesRef forwarded to sandbox dispatch ────────────────────

  it("forwards messagesRef to the sandbox dispatch when present on the work item", async () => {
    const fp = fakePublisher();
    let capturedDispatchBody: {
      runId: string;
      harnessId: string;
      input: Record<string, unknown>;
      messagesRef?: unknown;
    } | null = null;

    const fetchImpl = async (
      url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      if (url.includes("/_sandbox/dispatch")) {
        capturedDispatchBody = JSON.parse(init?.body as string) as {
          runId: string;
          harnessId: string;
          input: Record<string, unknown>;
          messagesRef?: unknown;
        };
        return new Response(makeBodyStream(FAKE_SSE_BODY), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const messagesRef = {
      url: "https://s3.example.com/link-dispatch/req-123?sig=abc",
      bytes: 98765,
      sha256:
        "cafebabe01234567cafebabe01234567cafebabe01234567cafebabe01234567",
    };

    const workWithRef: WorkItem = {
      ...validWorkItem,
      // messages are stripped inline (offloaded)
      harnessInput: { ...validWorkItem.harnessInput, messages: [] },
      messagesRef,
    };

    const deps: LocalDispatchDeps = {
      outbox: openInMemoryOutbox(),
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getNatsConnection: () => FAKE_NC,
      relayPublisher: fp.publisher,
    };

    await handleLocalDispatch(workWithRef, deps);

    // The dispatch body must carry messagesRef so the sandbox daemon can
    // re-inflate messages from object storage (same shape the WS path sends).
    expect(capturedDispatchBody).not.toBeNull();
    expect(capturedDispatchBody!.runId).toBe(workWithRef.runId);
    expect(capturedDispatchBody!.messagesRef).toEqual(messagesRef);
    // messages should be the stripped [] (the real ones are at the ref)
    expect(capturedDispatchBody!.input.messages).toEqual([]);
  });

  it("does not include messagesRef in sandbox dispatch when absent on the work item", async () => {
    const fp = fakePublisher();
    let capturedDispatchBody: {
      runId: string;
      harnessId: string;
      input: Record<string, unknown>;
      messagesRef?: unknown;
    } | null = null;

    const fetchImpl = async (
      url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      if (url.includes("/_sandbox/dispatch")) {
        capturedDispatchBody = JSON.parse(init?.body as string) as {
          runId: string;
          harnessId: string;
          input: Record<string, unknown>;
          messagesRef?: unknown;
        };
        return new Response(makeBodyStream(FAKE_SSE_BODY), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const deps: LocalDispatchDeps = {
      outbox: openInMemoryOutbox(),
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getNatsConnection: () => FAKE_NC,
      relayPublisher: fp.publisher,
    };

    // validWorkItem has no messagesRef
    await handleLocalDispatch(validWorkItem, deps);

    expect(capturedDispatchBody).not.toBeNull();
    expect(capturedDispatchBody!.runId).toBe(validWorkItem.runId);
    expect(capturedDispatchBody!.messagesRef).toBeUndefined();
  });

  // ── Test: the injected durable outbox is the relay's resend store ──────

  it("appends through the injected durable outbox and truncates on terminal ack", async () => {
    const fp = fakePublisher();
    const dir = mkdtempSync(join(tmpdir(), "hld-outbox-"));
    const outbox = openOutbox({ path: join(dir, "ob.sqlite") });

    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("/_sandbox/dispatch")) {
        return new Response(makeBodyStream(dispatchSSE(TEXT_CHUNKS)), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    await handleLocalDispatch(validWorkItem, {
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      outbox,
      getNatsConnection: () => FAKE_NC,
      relayPublisher: fp.publisher,
    });

    expect(fp.lines.at(-1)!.line.event).toEqual({ type: "done" });
    // The NATS post returns { ok:true, lastSeq>=terminalSeq }, so the relay's
    // terminal truncation runs: the run's rows are dropped from the outbox.
    expect(
      outbox.replay({ runId: RUN_ID, fenceToken: FENCE_TOKEN, fromSeq: 1 }),
    ).toEqual([]);
    outbox.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("truncates a terminally-failed run's rows from the injected file outbox (no leak)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hld-crash-"));
    const outbox = openOutbox({ path: join(dir, "ob.sqlite") });

    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("/_sandbox/dispatch")) {
        return new Response(makeBodyStream(dispatchSSE(TEXT_CHUNKS)), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    // The relay publish always fails — the run terminally fails after the retry
    // budget. The injected file outbox is still exercised (deps.outbox is
    // plumbed through), but the failed run's rows are dropped on the way out
    // rather than leaking durably.
    const failingPublisher = {
      publishLine: async () => {
        throw new Error("nats down");
      },
      publishDone: async () => {},
    };

    await handleLocalDispatch(validWorkItem, {
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      outbox,
      getNatsConnection: () => FAKE_NC,
      relayPublisher: failingPublisher,
      // Fast budget — this test asserts durability after exhaustion, not the
      // (widened) production retry window.
      relayRetry: { maxAttempts: 2, minTimeout: 1, maxTimeout: 2, jitter: 0 },
    }).catch(() => {}); // expected to fail after retries

    outbox.close();
    const reopened = openOutbox({ path: join(dir, "ob.sqlite") });
    const rows = reopened.replay({
      runId: RUN_ID,
      fenceToken: FENCE_TOKEN,
      fromSeq: 1,
    });
    // Terminally failed → the relay truncated the run's rows, even from the
    // durable file. No leak survives to wedge a future session.
    expect(rows).toEqual([]);
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // ── Test: abort signal is propagated to the dispatch leg ────────────────

  it("propagates abort signal to the sandbox dispatch fetch", async () => {
    const fp = fakePublisher();
    const ac = new AbortController();
    const capturedSignals: (AbortSignal | null | undefined)[] = [];

    const fetchImpl = async (
      url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedSignals.push(init?.signal ?? null);
      if (url.includes("/_sandbox/dispatch")) {
        return new Response(makeBodyStream(dispatchSSE(TEXT_CHUNKS)), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const deps: LocalDispatchDeps = {
      outbox: openInMemoryOutbox(),
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: ac.signal,
      getNatsConnection: () => FAKE_NC,
      relayPublisher: fp.publisher,
    };

    await handleLocalDispatch(validWorkItem, deps);

    // Only the sandbox dispatch leg fetches now; it receives a composite signal
    // that includes `ac` (the run signal AnyOf the start-timeout signal).
    expect(capturedSignals.length).toBe(1);
    expect(capturedSignals[0]).toBeInstanceOf(AbortSignal);
  });
});

// ── relayWorkItemFailure tests ──────────────────────────────────────────────

describe("relayWorkItemFailure", () => {
  it("publishes exactly an error chunk + done to NATS", async () => {
    const fp = fakePublisher();

    await relayWorkItemFailure(
      validWorkItem,
      { relayPublisher: fp.publisher, getNatsConnection: () => FAKE_NC },
      "work_item_expired",
      "credentials expired",
    );

    // One error line at seq 1 carrying code + message.
    expect(fp.lines).toHaveLength(1);
    expect(fp.lines[0]).toMatchObject({
      runId: RUN_ID,
      fenceToken: FENCE_TOKEN,
    });
    expect(fp.lines[0]!.line.seq).toBe(1);
    expect(fp.lines[0]!.line.event).toEqual({
      type: "error",
      code: "work_item_expired",
      message: "credentials expired",
    });

    // One done with finalSeq 1.
    expect(fp.dones).toHaveLength(1);
    expect(fp.dones[0]).toMatchObject({
      runId: RUN_ID,
      fenceToken: FENCE_TOKEN,
      finalSeq: 1,
    });
  });

  it("propagates a publisher failure", async () => {
    const publisher = {
      publishLine: async () => {
        throw new Error("nats publish rejected");
      },
      publishDone: async () => {},
    };

    await expect(
      relayWorkItemFailure(
        validWorkItem,
        { relayPublisher: publisher, getNatsConnection: () => FAKE_NC },
        "work_item_expired",
        "credentials expired",
      ),
    ).rejects.toThrow("nats publish rejected");
  });
});
