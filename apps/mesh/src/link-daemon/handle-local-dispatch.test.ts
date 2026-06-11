/**
 * Unit tests for handleLocalDispatch.
 *
 * All tests inject a stub `fetchImpl` — no real HTTP, no NATS, no DB.
 * The sandbox SSE body is simulated via a string-encoded stream; the cluster
 * `/chunks` endpoint is stubbed by reading the streaming NDJSON request body
 * fully and answering `{ ok, lastSeq }` like the real route.
 */
import { describe, expect, it } from "bun:test";
import type { UIMessageChunk } from "ai";
import type { WorkItem } from "../api/routes/decopilot/link-work-queue";
import { type RelayLine, relayLineSchema } from "../links/protocol/relay";
import {
  handleLocalDispatch,
  relayWorkItemFailure,
  type LocalDispatchDeps,
} from "./handle-local-dispatch";

// ── Fixtures ────────────────────────────────────────────────────────────────

const SANDBOX_BASE = "http://127.0.0.1:9123";
const CLUSTER_BASE = "https://studio.example.com";
const ORG_SLUG = "acme";
const DAEMON_TOKEN = "daemon-tok-abc";
const CLUSTER_TOKEN = "cluster-tok-xyz";
const FENCE_TOKEN = "fence-tok-123";
const RUN_ID = "run_01";

/** A minimal valid WorkItem fixture (mirrors work-poller.test.ts). */
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

/** Read a (streaming) NDJSON relay body fully and validate every line. */
async function readRelayLines(body: unknown): Promise<RelayLine[]> {
  const text =
    typeof body === "string"
      ? body
      : await new Response(body as ReadableStream<Uint8Array>).text();
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => relayLineSchema.parse(JSON.parse(l)));
}

/** Stub cluster /chunks handler: consume the body, ack everything. */
async function ackChunksPost(init?: RequestInit): Promise<Response> {
  const lines = await readRelayLines(init?.body);
  return new Response(
    JSON.stringify({ ok: true, lastSeq: lines.at(-1)?.seq ?? 0 }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// ── Test: successful relay ──────────────────────────────────────────────────

describe("handleLocalDispatch", () => {
  it("POSTs to sandbox dispatch and streams seq-numbered NDJSON relay lines to the cluster", async () => {
    const capturedRequests: Array<{ url: string; init: RequestInit }> = [];
    const capturedPosts: RelayLine[][] = [];
    let clusterTokenCalls = 0;

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

      if (url.includes("/links/runs/")) {
        const lines = await readRelayLines(init?.body);
        capturedPosts.push(lines);
        return new Response(
          JSON.stringify({ ok: true, lastSeq: lines.at(-1)?.seq ?? 0 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      throw new Error(`Unexpected fetch to ${url}`);
    };

    const deps: LocalDispatchDeps = {
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      clusterBaseUrl: CLUSTER_BASE,
      getClusterToken: async () => {
        clusterTokenCalls++;
        return CLUSTER_TOKEN;
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
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

    // Verify the dispatch body shape: { harnessId, input }
    const dispatchBodyStr = dispatchCall!.init.body as string;
    const dispatchBody = JSON.parse(dispatchBodyStr) as {
      harnessId: string;
      input: Record<string, unknown>;
    };
    expect(typeof dispatchBody.harnessId).toBe("string");
    expect(dispatchBody.harnessId).toBe("claude-code"); // derived from agent.id
    expect(dispatchBody.input).toEqual(validWorkItem.harnessInput);

    // ── Assert cluster chunk-relay call ────────────────────────────────────
    const chunkCalls = capturedRequests.filter((r) =>
      r.url.includes("/links/runs/"),
    );
    expect(chunkCalls).toHaveLength(1);
    expect(chunkCalls[0]!.url).toBe(
      `${CLUSTER_BASE}/api/${ORG_SLUG}/links/runs/${RUN_ID}/chunks`,
    );
    expect(clusterTokenCalls).toBe(1);
    const relayHeaders = chunkCalls[0]!.init.headers as Record<string, string>;
    expect(relayHeaders.authorization).toBe(`Bearer ${CLUSTER_TOKEN}`);
    expect(relayHeaders["x-fence-token"]).toBe(FENCE_TOKEN);
    expect(relayHeaders["content-type"]).toBe("application/x-ndjson");
    expect(relayHeaders["x-relay-from"]).toBe("1");

    // ── Assert a streaming NDJSON upload, not a pre-serialized JSON batch ──
    expect(chunkCalls[0]!.init.body).toBeInstanceOf(ReadableStream);
    expect(
      (chunkCalls[0]!.init as RequestInit & { duplex?: string }).duplex,
    ).toBe("half");

    const lines = capturedPosts[0]!;
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(lines.slice(0, 7).map((l) => l.event)).toEqual(
      TEXT_CHUNKS.map((chunk) => ({ type: "ui-message-chunk", chunk })),
    );
    expect(lines.at(-1)!.event).toEqual({ type: "done" });
  });

  // ── Test: non-ok sandbox dispatch → throw ──────────────────────────────

  it("throws when the sandbox dispatch returns a non-2xx response", async () => {
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
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      clusterBaseUrl: CLUSTER_BASE,
      getClusterToken: async () => CLUSTER_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };

    await expect(handleLocalDispatch(validWorkItem, deps)).rejects.toThrow(
      "[handleLocalDispatch] unknown_harness",
    );
  });

  it("throws when sandbox dispatch does not return response headers before the start timeout", async () => {
    let clusterTokenCalls = 0;
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
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      clusterBaseUrl: CLUSTER_BASE,
      getClusterToken: async () => {
        clusterTokenCalls++;
        return CLUSTER_TOKEN;
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dispatchStartTimeoutMs: 5,
    };

    await expect(handleLocalDispatch(validWorkItem, deps)).rejects.toThrow(
      "[handleLocalDispatch] dispatch start timed out after 5ms",
    );
    expect(clusterTokenCalls).toBe(0);
  });

  // ── Test: non-retriable cluster relay rejection → throw, single attempt ─

  it("throws without retrying when the cluster relay returns a 4xx (fence loss)", async () => {
    let relayPosts = 0;

    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("/_sandbox/dispatch")) {
        return new Response(makeBodyStream(FAKE_SSE_BODY), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.includes("/links/runs/")) {
        relayPosts++;
        return new Response(JSON.stringify({ error: "fenced" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const deps: LocalDispatchDeps = {
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      clusterBaseUrl: CLUSTER_BASE,
      getClusterToken: async () => CLUSTER_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };

    await expect(handleLocalDispatch(validWorkItem, deps)).rejects.toThrow(
      "[handleLocalDispatch] relay failed (409)",
    );
    expect(relayPosts).toBe(1);
  });

  // ── Test: transient relay failure → reconnect resends the full prefix ──

  it("retries a transient relay failure and resends the whole prefix from seq 1", async () => {
    let relayAttempts = 0;
    const capturedPosts: RelayLine[][] = [];
    const capturedFromSeq: string[] = [];

    const fetchImpl = async (
      url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      if (url.includes("/_sandbox/dispatch")) {
        return new Response(makeBodyStream(dispatchSSE(TEXT_CHUNKS)), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.endsWith("/chunks")) {
        relayAttempts++;
        const headers = (init?.headers ?? {}) as Record<string, string>;
        capturedFromSeq.push(headers["x-relay-from"] ?? "<missing>");
        if (relayAttempts === 1) {
          // Reject without reading the body — like a 503 from an LB.
          return new Response(JSON.stringify({ error: "temporary" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        const lines = await readRelayLines(init?.body);
        capturedPosts.push(lines);
        return new Response(
          JSON.stringify({ ok: true, lastSeq: lines.at(-1)?.seq ?? 0 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const deps: LocalDispatchDeps = {
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      clusterBaseUrl: CLUSTER_BASE,
      getClusterToken: async () => CLUSTER_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };

    await handleLocalDispatch(validWorkItem, deps);

    expect(relayAttempts).toBe(2);
    expect(capturedFromSeq).toEqual(["1", "1"]);
    // The reconnect attempt carries the complete prefix: all 7 chunks + done.
    expect(capturedPosts[0]!.map((l) => l.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(capturedPosts[0]!.at(-1)!.event).toEqual({ type: "done" });
  });

  // ── Test: harnessId from explicit deps override ─────────────────────────

  it("uses deps.harnessId when explicitly provided", async () => {
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
      if (url.includes("/links/runs/")) {
        return ackChunksPost(init);
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const deps: LocalDispatchDeps = {
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      clusterBaseUrl: CLUSTER_BASE,
      getClusterToken: async () => CLUSTER_TOKEN,
      harnessId: "codex",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };

    await handleLocalDispatch(validWorkItem, deps);
    expect(capturedDispatchBody!.harnessId).toBe("codex");
  });

  // ── Test: harnessId embedded in harnessInput takes priority over agent.id

  it("reads harnessId from harnessInput when agent.id is a virtual MCP id", async () => {
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
      if (url.includes("/links/runs/")) {
        return ackChunksPost(init);
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
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      clusterBaseUrl: CLUSTER_BASE,
      getClusterToken: async () => CLUSTER_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };

    await handleLocalDispatch(workWithEmbeddedHarnessId, deps);
    // capturedHarnessId is mutated inside the async fetchImpl closure —
    // TypeScript does not narrow it; assert non-null explicitly.
    expect(capturedHarnessId!).toBe("decopilot");
  });

  // ── Test: messagesRef forwarded to sandbox dispatch ────────────────────

  it("forwards messagesRef to the sandbox dispatch when present on the work item", async () => {
    let capturedDispatchBody: {
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
          harnessId: string;
          input: Record<string, unknown>;
          messagesRef?: unknown;
        };
        return new Response(makeBodyStream(FAKE_SSE_BODY), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.includes("/links/runs/")) {
        return ackChunksPost(init);
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
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      clusterBaseUrl: CLUSTER_BASE,
      getClusterToken: async () => CLUSTER_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };

    await handleLocalDispatch(workWithRef, deps);

    // The dispatch body must carry messagesRef so the sandbox daemon can
    // re-inflate messages from object storage (same shape the WS path sends).
    expect(capturedDispatchBody).not.toBeNull();
    expect(capturedDispatchBody!.messagesRef).toEqual(messagesRef);
    // messages should be the stripped [] (the real ones are at the ref)
    expect(capturedDispatchBody!.input.messages).toEqual([]);
  });

  it("does not include messagesRef in sandbox dispatch when absent on the work item", async () => {
    let capturedDispatchBody: {
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
          harnessId: string;
          input: Record<string, unknown>;
          messagesRef?: unknown;
        };
        return new Response(makeBodyStream(FAKE_SSE_BODY), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.includes("/links/runs/")) {
        return ackChunksPost(init);
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const deps: LocalDispatchDeps = {
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      clusterBaseUrl: CLUSTER_BASE,
      getClusterToken: async () => CLUSTER_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };

    // validWorkItem has no messagesRef
    await handleLocalDispatch(validWorkItem, deps);

    expect(capturedDispatchBody).not.toBeNull();
    expect(capturedDispatchBody!.messagesRef).toBeUndefined();
  });

  // ── Test: abort signal is propagated ───────────────────────────────────

  it("propagates abort signal to the dispatch and relay fetches", async () => {
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
      if (url.includes("/links/runs/")) {
        return ackChunksPost(init);
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const deps: LocalDispatchDeps = {
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      clusterBaseUrl: CLUSTER_BASE,
      getClusterToken: async () => CLUSTER_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: ac.signal,
    };

    await handleLocalDispatch(validWorkItem, deps);

    // The sandbox dispatch receives a composite signal that includes `ac`;
    // the relay fetch receives the original run signal.
    expect(capturedSignals.length).toBe(2);
    expect(capturedSignals[0]).toBeInstanceOf(AbortSignal);
    expect(capturedSignals[1]).toBe(ac.signal);
  });
});

// ── relayWorkItemFailure tests ──────────────────────────────────────────────

describe("relayWorkItemFailure", () => {
  it("posts exactly error+done NDJSON lines with required headers to the correct URL", async () => {
    const captured: Array<{ url: string; init: RequestInit }> = [];

    const fetchImpl = async (
      url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      captured.push({ url, init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, lastSeq: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await relayWorkItemFailure(
      validWorkItem,
      {
        clusterBaseUrl: CLUSTER_BASE,
        getClusterToken: async () => CLUSTER_TOKEN,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      "work_item_expired",
      "credentials expired",
    );

    expect(captured).toHaveLength(1);
    const { url, init } = captured[0]!;

    // Correct URL
    expect(url).toBe(
      `${CLUSTER_BASE}/api/${ORG_SLUG}/links/runs/${RUN_ID}/chunks`,
    );

    // Required headers
    const headers = init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${CLUSTER_TOKEN}`);
    expect(headers["x-fence-token"]).toBe(FENCE_TOKEN);
    expect(headers["content-type"]).toBe("application/x-ndjson");
    expect(headers["x-relay-from"]).toBe("1");

    // Body: exactly 2 NDJSON lines
    const lines = (init.body as string)
      .split("\n")
      .filter((l) => l.length > 0)
      .map(
        (l) =>
          JSON.parse(l) as {
            seq: number;
            event: { type: string; code?: string; message?: string };
          },
      );

    expect(lines).toHaveLength(2);

    // Line 1: error event
    expect(lines[0]!.seq).toBe(1);
    expect(lines[0]!.event.type).toBe("error");
    expect(lines[0]!.event.code).toBe("work_item_expired");
    expect(lines[0]!.event.message).toBe("credentials expired");

    // Line 2: done event
    expect(lines[1]!.seq).toBe(2);
    expect(lines[1]!.event.type).toBe("done");
  });

  it("throws when the cluster returns a non-2xx status", async () => {
    const fetchImpl = async (): Promise<Response> => {
      return new Response(JSON.stringify({ error: "fenced" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      relayWorkItemFailure(
        validWorkItem,
        {
          clusterBaseUrl: CLUSTER_BASE,
          getClusterToken: async () => CLUSTER_TOKEN,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
        "work_item_expired",
        "credentials expired",
      ),
    ).rejects.toThrow("cluster rejected failure relay (409)");
  });

  it("propagates the abort signal to the fetch", async () => {
    const ac = new AbortController();
    const capturedSignals: (AbortSignal | null | undefined)[] = [];

    const fetchImpl = async (
      _url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedSignals.push(init?.signal ?? null);
      return new Response(JSON.stringify({ ok: true, lastSeq: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await relayWorkItemFailure(
      validWorkItem,
      {
        clusterBaseUrl: CLUSTER_BASE,
        getClusterToken: async () => CLUSTER_TOKEN,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        signal: ac.signal,
      },
      "work_item_expired",
      "credentials expired",
    );

    expect(capturedSignals).toHaveLength(1);
    expect(capturedSignals[0]).toBe(ac.signal);
  });
});
