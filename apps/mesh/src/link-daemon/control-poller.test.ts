/**
 * Unit tests for the control-poll loop's frame routing (Phase C / C-bis).
 *
 * Injects a stub `fetchImpl` — no real HTTP, no NATS, no DB (mirrors
 * work-poller.test.ts). Focus: `cancel` routes to onCancel(runId) and
 * `cancel_req` routes to onCancelReq(reqId).
 */
import { describe, expect, it } from "bun:test";
import { runControlPollLoop } from "./control-poller";
import { encodeControlFrame } from "../api/routes/decopilot/control-frames";

const BASE_URL = "https://studio.example.com";
const ORG_SLUG = "acme";

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
      orgSlug: ORG_SLUG,
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
      orgSlug: ORG_SLUG,
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
      orgSlug: ORG_SLUG,
      getAccessToken: () => "tok",
      signal: ac.signal,
      fetchImpl,
      onCancel: () => {},
    });

    expect(call).toBeGreaterThanOrEqual(2);
  });
});
