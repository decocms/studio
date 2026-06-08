/**
 * Unit tests for handleLocalDispatch.
 *
 * All tests inject a stub `fetchImpl` — no real HTTP, no NATS, no DB.
 * The ReadableStream body is simulated via a simple string-encoded SSE block.
 */
import { describe, expect, it } from "bun:test";
import {
  handleLocalDispatch,
  type LocalDispatchDeps,
} from "./handle-local-dispatch";
import type { WorkItem } from "../api/routes/decopilot/link-work-queue";

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

// ── Test: successful relay ──────────────────────────────────────────────────

describe("handleLocalDispatch", () => {
  it("POSTs to sandbox dispatch and relays SSE body to cluster ingest", async () => {
    const capturedRequests: Array<{ url: string; init: RequestInit }> = [];
    let capturedIngestBody: string | null = null;

    const fetchImpl = async (
      url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedRequests.push({ url, init: init ?? {} });

      if (url.includes("/_sandbox/dispatch")) {
        // Sandbox dispatch: return 200 with a fake SSE stream body.
        return new Response(makeBodyStream(FAKE_SSE_BODY), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }

      if (url.includes("/links/runs/")) {
        // Cluster ingest: capture the relayed body and return 200.
        if (init?.body instanceof ReadableStream) {
          const reader = init.body.getReader();
          const dec = new TextDecoder();
          let text = "";
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) text += dec.decode(value, { stream: true });
          }
          capturedIngestBody = text;
        }
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
    const ingestCall = capturedRequests.find((r) =>
      r.url.includes("/links/runs/"),
    );
    expect(ingestCall).toBeDefined();
    expect(ingestCall!.url).toBe(
      `${CLUSTER_BASE}/api/${ORG_SLUG}/links/runs/${RUN_ID}/stream`,
    );
    const ingestHeaders = ingestCall!.init.headers as Record<string, string>;
    expect(ingestHeaders.authorization).toBe(`Bearer ${CLUSTER_TOKEN}`);
    expect(ingestHeaders["x-fence-token"]).toBe(FENCE_TOKEN);
    expect(ingestHeaders["content-type"]).toBe("text/event-stream");

    // ── Assert SSE body was relayed (not buffered: it's a ReadableStream) ──
    expect(ingestCall!.init.body).toBeInstanceOf(ReadableStream);
    // capturedIngestBody is mutated inside the async fetchImpl closure —
    // TypeScript does not narrow it; assert non-null explicitly.
    expect(capturedIngestBody!).toBe(FAKE_SSE_BODY);
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
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("/_sandbox/dispatch")) {
        return new Response(makeBodyStream(FAKE_SSE_BODY), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.includes("/links/runs/")) {
        // Drain the stream to avoid AbortError on the sandbox side.
        if (typeof url === "string") {
          return new Response(JSON.stringify({ error: "fenced" }), {
            status: 409,
            headers: { "content-type": "application/json" },
          });
        }
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
        // Drain the body so the stream doesn't hang.
        if (init?.body instanceof ReadableStream) {
          const reader = init.body.getReader();
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        }
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

  it("reads harnessId from harnessInput when present", async () => {
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
        if (init?.body instanceof ReadableStream) {
          const reader = init.body.getReader();
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        }
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
        harnessId: "codex", // embedded in the record
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
    expect(capturedHarnessId!).toBe("codex");
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
        if (init?.body instanceof ReadableStream) {
          const reader = init.body.getReader();
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        }
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
        if (init?.body instanceof ReadableStream) {
          const reader = init.body.getReader();
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        }
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
        return new Response(makeBodyStream(FAKE_SSE_BODY), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.includes("/links/runs/")) {
        if (init?.body instanceof ReadableStream) {
          const reader = init.body.getReader();
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        }
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

    // Both fetches should have received the abort signal.
    expect(capturedSignals.length).toBe(2);
    expect(capturedSignals[0]).toBe(ac.signal);
    expect(capturedSignals[1]).toBe(ac.signal);
  });
});
