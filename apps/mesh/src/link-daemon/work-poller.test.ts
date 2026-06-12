/**
 * Unit tests for the work-poll loop.
 *
 * All tests inject a stub `fetchImpl` — no real HTTP, no NATS, no DB.
 * The AbortController is used to stop the loop after verifying the behaviour.
 */
import { describe, expect, it, mock, spyOn } from "bun:test";
import { runWorkPollLoop } from "./work-poller";
import type { WorkItem } from "../api/routes/decopilot/link-work-queue";
import { LINK_PROTOCOL_VERSION } from "../links/protocol";

const BASE_URL = "https://studio.example.com";
const ORG_SLUG = "acme";

/** A minimal valid WorkItem fixture. */
const validWorkItem: WorkItem = {
  runId: "run_01",
  threadId: "thrd_01",
  orgId: "org_01",
  userId: "usr_01",
  runFenceToken: "tok-fence-1",
  orgSlug: ORG_SLUG,
  harnessInput: {
    threadId: "thrd_01",
    runId: "run_01",
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

/** Helper: build a Response-like object for the stub. */
function makeResponse(status: number, body?: unknown): Response {
  return {
    status,
    json: () => Promise.resolve(body),
    // minimal subset needed by the poller
  } as unknown as Response;
}

describe("runWorkPollLoop", () => {
  it("parses and delivers a 200 work item, then stops on abort", async () => {
    const received: WorkItem[] = [];
    const ac = new AbortController();

    let callCount = 0;
    const fetchImpl = mock(async () => {
      callCount++;
      if (callCount === 1) {
        return makeResponse(200, validWorkItem);
      }
      // After the first item, abort so the loop stops.
      ac.abort();
      // Return 204 so the loop processes the abort check before another fetch.
      return makeResponse(204);
    });

    await runWorkPollLoop({
      baseUrl: BASE_URL,
      onWork: async (item) => {
        received.push(item);
      },
      getAccessToken: async () => "test-token",
      signal: ac.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(received).toHaveLength(1);
    const item0 = received[0] as WorkItem;
    expect(item0.runId).toBe("run_01");
    expect(item0.runFenceToken).toBe("tok-fence-1");
    expect(item0.harnessInput.threadId).toBe("thrd_01");
  });

  it("returns null-equivalent (no onWork call) on 204 and stops on abort", async () => {
    const received: WorkItem[] = [];
    const ac = new AbortController();

    let callCount = 0;
    const fetchImpl = mock(async () => {
      callCount++;
      if (callCount >= 2) ac.abort();
      return makeResponse(204);
    });

    await runWorkPollLoop({
      baseUrl: BASE_URL,
      onWork: async (item) => {
        received.push(item);
      },
      getAccessToken: async () => "tok",
      signal: ac.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // No items delivered — 204 never calls onWork.
    expect(received).toHaveLength(0);
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  it("skips a malformed body (schema validation fails) without crashing the loop", async () => {
    const received: WorkItem[] = [];
    const ac = new AbortController();

    let callCount = 0;
    const fetchImpl = mock(async () => {
      callCount++;
      if (callCount === 1) {
        // Missing required fields — schema should reject this.
        return makeResponse(200, { runId: "only-run-id" });
      }
      ac.abort();
      return makeResponse(204);
    });

    await runWorkPollLoop({
      baseUrl: BASE_URL,
      onWork: async (item) => {
        received.push(item);
      },
      getAccessToken: async () => "tok",
      signal: ac.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Malformed item skipped — no onWork call.
    expect(received).toHaveLength(0);
  });

  it("stops when signal is already aborted before first fetch", async () => {
    const ac = new AbortController();
    ac.abort();

    const fetchImpl = mock(async () => makeResponse(204));

    await runWorkPollLoop({
      baseUrl: BASE_URL,
      onWork: async () => {},
      getAccessToken: async () => "tok",
      signal: ac.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Loop should exit immediately without ever calling fetch.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the correct user-scoped URL with the timeout param", async () => {
    const urls: string[] = [];
    const ac = new AbortController();

    const fetchImpl = mock(async (url: string) => {
      urls.push(url);
      ac.abort();
      return makeResponse(204);
    });

    await runWorkPollLoop({
      baseUrl: "https://cluster.example.com",
      onWork: async () => {},
      getAccessToken: async () => "tok",
      signal: ac.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollTimeoutSecs: 15,
    });

    expect(urls[0]).toBe(
      "https://cluster.example.com/api/links/work?timeout=15",
    );
  });

  it("includes Bearer token in Authorization header", async () => {
    const headers: Record<string, string>[] = [];
    const ac = new AbortController();

    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      headers.push((init?.headers ?? {}) as Record<string, string>);
      ac.abort();
      return makeResponse(204);
    });

    await runWorkPollLoop({
      baseUrl: BASE_URL,
      onWork: async () => {},
      getAccessToken: async () => "my-fresh-token",
      signal: ac.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(headers[0]?.Authorization).toBe("Bearer my-fresh-token");
  });

  it("advertises the link protocol version via x-link-protocol on every poll", async () => {
    const headers: Record<string, string>[] = [];
    const ac = new AbortController();

    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      headers.push((init?.headers ?? {}) as Record<string, string>);
      if (headers.length >= 2) ac.abort();
      return makeResponse(204);
    });

    await runWorkPollLoop({
      baseUrl: BASE_URL,
      onWork: async () => {},
      getAccessToken: async () => "tok",
      signal: ac.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(headers.length).toBeGreaterThanOrEqual(2);
    for (const h of headers) {
      expect(h["x-link-protocol"]).toBe(String(LINK_PROTOCOL_VERSION));
    }
  });

  it("logs the server message and stops permanently on 426 protocol_mismatch", async () => {
    const received: WorkItem[] = [];
    const ac = new AbortController();
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const serverMessage =
      "Link protocol v2 is no longer supported. Re-run: bunx decocms@latest link";
    const fetchImpl = mock(async () =>
      makeResponse(426, {
        error: "protocol_mismatch",
        minSupported: 3,
        message: serverMessage,
      }),
    );

    try {
      // The loop must resolve on its own — WITHOUT the abort signal firing —
      // and without backing off into another poll (no hot-retry).
      await runWorkPollLoop({
        baseUrl: BASE_URL,
        onWork: async (item) => {
          received.push(item);
        },
        getAccessToken: async () => "tok",
        signal: ac.signal,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(ac.signal.aborted).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(received).toHaveLength(0);
      const logged = errorSpy.mock.calls.map((args) => String(args[0]));
      expect(logged.some((line) => line.includes(serverMessage))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("stops on 426 even when the body is not JSON, with a local remediation message", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const ac = new AbortController();

    const fetchImpl = mock(async () => {
      return {
        status: 426,
        json: () => Promise.reject(new Error("not json")),
      } as unknown as Response;
    });

    try {
      await runWorkPollLoop({
        baseUrl: BASE_URL,
        onWork: async () => {},
        getAccessToken: async () => "tok",
        signal: ac.signal,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const logged = errorSpy.mock.calls.map((args) => String(args[0]));
      expect(
        logged.some((line) => line.includes("bunx decocms@latest link")),
      ).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("calls getAccessToken on every poll iteration", async () => {
    let tokenCallCount = 0;
    const ac = new AbortController();

    let fetchCount = 0;
    const fetchImpl = mock(async () => {
      fetchCount++;
      if (fetchCount >= 3) ac.abort();
      return makeResponse(204);
    });

    await runWorkPollLoop({
      baseUrl: BASE_URL,
      onWork: async () => {},
      getAccessToken: async () => {
        tokenCallCount++;
        return "tok";
      },
      signal: ac.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Token should be resolved at least as many times as fetch was called.
    expect(tokenCallCount).toBeGreaterThanOrEqual(fetchCount);
  });

  it("delivers multiple consecutive work items in order", async () => {
    const received: string[] = [];
    const ac = new AbortController();

    const items = [
      { ...validWorkItem, runId: "run_A" },
      { ...validWorkItem, runId: "run_B" },
      { ...validWorkItem, runId: "run_C" },
    ];
    let idx = 0;

    const fetchImpl = mock(async () => {
      if (idx < items.length) {
        return makeResponse(200, items[idx++]);
      }
      ac.abort();
      return makeResponse(204);
    });

    await runWorkPollLoop({
      baseUrl: BASE_URL,
      onWork: async (item) => {
        received.push(item.runId);
      },
      getAccessToken: async () => "tok",
      signal: ac.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(received).toEqual(["run_A", "run_B", "run_C"]);
  });

  it("advertises capabilities grown in place between polls (re-probe pickup)", async () => {
    // The daemon's capability re-probe mutates the shared array after the
    // loop has started; the NEXT poll must carry the updated header — that
    // is the whole propagation mechanism (no restart, no re-registration).
    const ac = new AbortController();
    const capabilities: import("../links/protocol").Capability[] = [
      "decopilot-sandbox",
      "body-offload",
    ];
    const seenHeaders: (string | undefined)[] = [];

    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      seenHeaders.push(headers["x-link-capabilities"]);
      if (seenHeaders.length === 1) {
        // Simulate the re-probe discovering claude-code mid-loop.
        capabilities.push("claude-code");
        return makeResponse(204);
      }
      ac.abort();
      return makeResponse(204);
    });

    await runWorkPollLoop({
      baseUrl: BASE_URL,
      onWork: async () => {},
      getAccessToken: async () => "tok",
      signal: ac.signal,
      capabilities,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(seenHeaders[0]).toBe("decopilot-sandbox,body-offload");
    expect(seenHeaders[1]).toBe("decopilot-sandbox,body-offload,claude-code");
  });
});
