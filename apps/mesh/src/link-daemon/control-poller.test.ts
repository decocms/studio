/**
 * Unit tests for the control-poll loop's frame routing (Phase C / C-bis).
 *
 * Injects a stub `fetchImpl` — no real HTTP, no NATS, no DB (mirrors
 * work-poller.test.ts). Focus: `cancel` routes to onCancel(runId) and
 * `cancel_req` routes to onCancelReq(reqId).
 */
import { describe, expect, it, mock } from "bun:test";
import { runControlPollLoop } from "./control-poller";
import { encodeControlFrame } from "../api/routes/decopilot/control-frames";

const BASE_URL = "https://studio.example.com";

function jsonResponse(status: number, text: string): Response {
  return {
    status,
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

describe("runControlPollLoop frame routing", () => {
  it("routes a cancel frame to onCancel(runId)", async () => {
    const ac = new AbortController();
    const cancelled: string[] = [];
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      if (call === 1) {
        return jsonResponse(
          200,
          encodeControlFrame({ type: "cancel", runId: "run-9" }),
        );
      }
      ac.abort();
      return jsonResponse(204, "");
    }) as unknown as typeof fetch;

    await runControlPollLoop({
      baseUrl: BASE_URL,
      getAccessToken: () => "tok",
      signal: ac.signal,
      fetchImpl,
      onCancel: (runId) => cancelled.push(runId),
    });

    expect(cancelled).toEqual(["run-9"]);
  });

  it("routes a cancel_req frame to onCancelReq(reqId)", async () => {
    const ac = new AbortController();
    const cancelledReqs: string[] = [];
    const cancelledRuns: string[] = [];
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      if (call === 1) {
        return jsonResponse(
          200,
          encodeControlFrame({ type: "cancel_req", reqId: "req-abc" }),
        );
      }
      ac.abort();
      return jsonResponse(204, "");
    }) as unknown as typeof fetch;

    await runControlPollLoop({
      baseUrl: BASE_URL,
      getAccessToken: () => "tok",
      signal: ac.signal,
      fetchImpl,
      onCancel: (runId) => cancelledRuns.push(runId),
      onCancelReq: (reqId) => cancelledReqs.push(reqId),
    });

    expect(cancelledReqs).toEqual(["req-abc"]);
    expect(cancelledRuns).toEqual([]); // cancel_req must NOT fire onCancel
  });

  it("ignores cancel_req when onCancelReq is not provided (no throw)", async () => {
    const ac = new AbortController();
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      if (call === 1) {
        return jsonResponse(
          200,
          encodeControlFrame({ type: "cancel_req", reqId: "req-xyz" }),
        );
      }
      ac.abort();
      return jsonResponse(204, "");
    }) as unknown as typeof fetch;

    // No onCancelReq — must not throw / must keep looping until abort.
    await runControlPollLoop({
      baseUrl: BASE_URL,
      getAccessToken: () => "tok",
      signal: ac.signal,
      fetchImpl,
      onCancel: () => {},
    });

    expect(call).toBeGreaterThanOrEqual(2);
  });

  it("uses the correct user-scoped URL with the timeout param", async () => {
    const urls: string[] = [];
    const ac = new AbortController();

    const fetchImpl = mock(async (url: string) => {
      urls.push(url);
      ac.abort();
      return new Response(null, { status: 204 });
    });

    await runControlPollLoop({
      baseUrl: "https://cluster.example.com",
      getAccessToken: async () => "tok",
      signal: ac.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollTimeoutSecs: 15,
      onCancel: () => {},
    });

    expect(urls[0]).toBe(
      "https://cluster.example.com/api/links/control?timeout=15",
    );
  });
});
