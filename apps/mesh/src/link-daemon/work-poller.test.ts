/**
 * Unit tests for the work-poll loop.
 *
 * All tests inject a stub `fetchImpl` — no real HTTP, no NATS, no DB.
 * The AbortController is used to stop the loop after verifying the behaviour.
 */
import { describe, expect, it, mock } from "bun:test";
import { runWorkPollLoop } from "./work-poller";
import type { WorkItem } from "../api/routes/decopilot/link-work-queue";

const BASE_URL = "https://studio.example.com";
const ORG_SLUG = "acme";

/** A minimal valid WorkItem fixture. */
const validWorkItem: WorkItem = {
  runId: "run_01",
  threadId: "thrd_01",
  orgId: "org_01",
  userId: "usr_01",
  runFenceToken: "tok-fence-1",
  harnessInput: {
    threadId: "thrd_01",
    runId: "run_01",
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
      orgSlug: ORG_SLUG,
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
      orgSlug: ORG_SLUG,
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
      orgSlug: ORG_SLUG,
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
      orgSlug: ORG_SLUG,
      onWork: async () => {},
      getAccessToken: async () => "tok",
      signal: ac.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Loop should exit immediately without ever calling fetch.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the correct URL including orgSlug and timeout param", async () => {
    const urls: string[] = [];
    const ac = new AbortController();

    const fetchImpl = mock(async (url: string) => {
      urls.push(url);
      ac.abort();
      return makeResponse(204);
    });

    await runWorkPollLoop({
      baseUrl: "https://cluster.example.com",
      orgSlug: "my-org",
      onWork: async () => {},
      getAccessToken: async () => "tok",
      signal: ac.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollTimeoutSecs: 15,
    });

    expect(urls[0]).toBe(
      "https://cluster.example.com/api/my-org/links/work?timeout=15",
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
      orgSlug: ORG_SLUG,
      onWork: async () => {},
      getAccessToken: async () => "my-fresh-token",
      signal: ac.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(headers[0]?.Authorization).toBe("Bearer my-fresh-token");
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
      orgSlug: ORG_SLUG,
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
      orgSlug: ORG_SLUG,
      onWork: async (item) => {
        received.push(item.runId);
      },
      getAccessToken: async () => "tok",
      signal: ac.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(received).toEqual(["run_A", "run_B", "run_C"]);
  });
});
