/**
 * Unit tests for handleLocalDispatch.
 *
 * All tests inject a stub `fetchImpl` — no real HTTP, no NATS, no DB.
 * The ReadableStream body is simulated via a simple string-encoded SSE block.
 */
import { describe, expect, it } from "bun:test";
import type { UIMessageChunk } from "ai";
import type { LinkIngestBatch } from "../api/routes/decopilot/link-ingest-batch-schema";
import type { WorkItem } from "../api/routes/decopilot/link-work-queue";
import {
  handleLocalDispatch,
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
    models: {
      credentialId: "cred_01",
      thinking: { id: "claude-3-7-sonnet", title: "Sonnet" },
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

// ── Test: successful relay ──────────────────────────────────────────────────

describe("handleLocalDispatch", () => {
  it("POSTs to sandbox dispatch and appends JSON part batches to cluster ingest", async () => {
    const capturedRequests: Array<{ url: string; init: RequestInit }> = [];
    const capturedBatches: LinkIngestBatch[] = [];
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
        capturedBatches.push(JSON.parse(init?.body as string));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected fetch to ${url}`);
    };

    const deps: LocalDispatchDeps = {
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      clusterBaseUrl: CLUSTER_BASE,
      orgSlug: "stale-deps-org",
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

    // ── Assert cluster ingest call ──────────────────────────────────────────
    const ingestCalls = capturedRequests.filter((r) =>
      r.url.includes("/links/runs/"),
    );
    expect(ingestCalls).toHaveLength(2);
    expect(ingestCalls.every((call) => call.url.endsWith("/parts"))).toBe(true);
    expect(ingestCalls[0]!.url).toBe(
      `${CLUSTER_BASE}/api/${ORG_SLUG}/links/runs/${RUN_ID}/parts`,
    );
    expect(clusterTokenCalls).toBe(1);
    for (const call of ingestCalls) {
      const ingestHeaders = call.init.headers as Record<string, string>;
      expect(ingestHeaders.authorization).toBe(`Bearer ${CLUSTER_TOKEN}`);
      expect(ingestHeaders["x-fence-token"]).toBe(FENCE_TOKEN);
      expect(ingestHeaders["content-type"]).toBe("application/json");
    }

    // ── Assert JSON batches were appended, not a streaming upload ──────────
    expect(ingestCalls[0]!.init.body).toBeString();
    expect(ingestCalls[0]!.init.body).not.toBeInstanceOf(ReadableStream);
    expect(capturedBatches[0]?.batchId).toBe(`${RUN_ID}:0`);
    expect(capturedBatches[0]?.done).toBe(false);
    expect(capturedBatches[0]?.rows.length).toBeGreaterThan(0);
    expect(capturedBatches.at(-1)).toEqual({
      batchId: `${RUN_ID}:done`,
      rows: [],
      done: true,
    });
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
      orgSlug: ORG_SLUG,
      getClusterToken: async () => CLUSTER_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };

    await expect(handleLocalDispatch(validWorkItem, deps)).rejects.toThrow(
      "[handleLocalDispatch] unknown_harness",
    );
  });

  // ── Test: non-ok cluster ingest → throw ────────────────────────────────

  it("throws when the cluster ingest returns a non-2xx response", async () => {
    let appendCount = 0;

    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("/_sandbox/dispatch")) {
        return new Response(makeBodyStream(FAKE_SSE_BODY), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.includes("/links/runs/")) {
        appendCount++;
        if (appendCount === 1) {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
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
      orgSlug: ORG_SLUG,
      getClusterToken: async () => CLUSTER_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };

    await expect(handleLocalDispatch(validWorkItem, deps)).rejects.toThrow(
      "[handleLocalDispatch] fenced",
    );
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
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const deps: LocalDispatchDeps = {
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      clusterBaseUrl: CLUSTER_BASE,
      orgSlug: ORG_SLUG,
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
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
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
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      clusterBaseUrl: CLUSTER_BASE,
      orgSlug: ORG_SLUG,
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
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
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
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      clusterBaseUrl: CLUSTER_BASE,
      orgSlug: ORG_SLUG,
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
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const deps: LocalDispatchDeps = {
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      clusterBaseUrl: CLUSTER_BASE,
      orgSlug: ORG_SLUG,
      getClusterToken: async () => CLUSTER_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };

    // validWorkItem has no messagesRef
    await handleLocalDispatch(validWorkItem, deps);

    expect(capturedDispatchBody).not.toBeNull();
    expect(capturedDispatchBody!.messagesRef).toBeUndefined();
  });

  // ── Test: abort signal is propagated ───────────────────────────────────

  it("propagates abort signal to the dispatch fetch", async () => {
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
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const deps: LocalDispatchDeps = {
      sandboxDispatchUrl: SANDBOX_BASE,
      sandboxDaemonToken: DAEMON_TOKEN,
      clusterBaseUrl: CLUSTER_BASE,
      orgSlug: ORG_SLUG,
      getClusterToken: async () => CLUSTER_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: ac.signal,
    };

    await handleLocalDispatch(validWorkItem, deps);

    // Dispatch plus every cluster append fetch should receive the abort signal.
    expect(capturedSignals.length).toBe(3);
    expect(capturedSignals[0]).toBe(ac.signal);
    expect(capturedSignals[1]).toBe(ac.signal);
    expect(capturedSignals[2]).toBe(ac.signal);
  });
});
