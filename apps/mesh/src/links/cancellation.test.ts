/**
 * Cancellation matrix: exercises the daemon's dispatch + cancel route
 * pair against the four interesting orderings of cancel vs dispatch.
 *
 * These run against the route handlers directly (not over a real socket)
 * so they're fast and deterministic. The HMAC signing path uses the
 * shared `apps/mesh/src/links/protocol` fixtures so both the cluster `remoteDispatch`
 * tests and these tests fail together if the wire contract drifts.
 *
 * The matrix:
 *   1. Cancel BEFORE dispatch → 410 Gone (tombstone semantics).
 *   2. Cancel DURING dispatch → AbortController fires, harness loop stops,
 *      SSE stream emits `{type:"done"}` and closes promptly.
 *   3. Cancel for an unknown runId → 204 (idempotent, no-op).
 *   4. Cancel with bad HMAC → 401.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  handleCancelRequest,
  handleDispatchRequest,
  resetDispatchStateForTests,
} from "@decocms/sandbox/daemon/routes/dispatch";
import { fixtures, signRequest } from "./protocol";

const SECRET = "test-secret-32-bytes-padding-padding-padding";

interface SlowHarnessHandle {
  harness: { stream: () => AsyncIterable<unknown> };
  chunksEmitted: () => number;
  done: () => boolean;
}

/** A harness that yields up to `count` chunks, sleeping `delayMs` between
 *  yields. Records how many it actually emitted so the cancel-during test
 *  can assert that it stopped well short of `count`. */
function makeSlowHarness(count = 100, delayMs = 10): SlowHarnessHandle {
  let emitted = 0;
  let finished = false;
  const harness = {
    async *stream() {
      try {
        for (let i = 0; i < count; i++) {
          await new Promise((r) => setTimeout(r, delayMs));
          emitted++;
          yield { type: "text-delta", id: "m1", delta: String(i) };
        }
      } finally {
        finished = true;
      }
    },
  };
  return {
    harness,
    chunksEmitted: () => emitted,
    done: () => finished,
  };
}

function makeDeps(
  overrides: Partial<Parameters<typeof handleDispatchRequest>[1]> = {},
) {
  return {
    bearerSecret: SECRET,
    lookupHarness: () => makeSlowHarness().harness,
    seenNonce: () => false,
    ...overrides,
  };
}

function signedDispatch(body: string): Request {
  const sig = signRequest({
    secret: SECRET,
    method: "POST",
    path: "/_sandbox/dispatch",
    body,
  });
  return new Request("http://localhost/_sandbox/dispatch", {
    method: "POST",
    body,
    headers: { ...sig, "Content-Type": "application/json" },
  });
}

function signedCancel(runId: string): Request {
  const path = `/_sandbox/runs/${runId}`;
  const sig = signRequest({ secret: SECRET, method: "DELETE", path, body: "" });
  return new Request(`http://localhost${path}`, {
    method: "DELETE",
    headers: { ...sig },
  });
}

describe("cancellation matrix", () => {
  // The dispatch route uses module-scoped maps for activeRuns + tombstones;
  // reset between tests so a stale entry from a previous case can't bleed
  // into the next. Cross-test pollution here is subtle (tombstones live 60s).
  afterEach(() => {
    resetDispatchStateForTests();
  });

  it("DELETE before dispatch tombstones the runId so the dispatch returns 410", async () => {
    const runId = "run-cancel-before";
    const cancelRes = await handleCancelRequest(signedCancel(runId), {
      bearerSecret: SECRET,
      seenNonce: () => false,
    });
    expect(cancelRes.status).toBe(204);

    const body = JSON.stringify({
      harnessId: "fake",
      input: { ...fixtures.FIXTURE_MINIMAL_INPUT, runId },
    });
    const res = await handleDispatchRequest(signedDispatch(body), makeDeps());
    expect(res.status).toBe(410);
    // Drain the response so any stream is closed before the next test runs.
    await res.text().catch(() => "");
  });

  it("DELETE during dispatch aborts the harness loop and closes the SSE stream", async () => {
    const runId = "run-cancel-during";
    const handle = makeSlowHarness(100, 10);

    const body = JSON.stringify({
      harnessId: "fake",
      input: { ...fixtures.FIXTURE_MINIMAL_INPUT, runId },
    });

    const dispatchRes = await handleDispatchRequest(
      signedDispatch(body),
      makeDeps({ lookupHarness: () => handle.harness }),
    );
    expect(dispatchRes.status).toBe(200);
    expect(dispatchRes.body).not.toBeNull();

    // Start reading the stream in the background. We'll cancel mid-flight
    // and then wait for the stream to drain.
    const reader = dispatchRes.body!.getReader();
    const decoder = new TextDecoder();
    let collected = "";
    const drainPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        collected += decoder.decode(value, { stream: true });
      }
      collected += decoder.decode();
    })();

    // Let a few chunks land, then fire the cancel.
    await new Promise((r) => setTimeout(r, 50));
    const emittedBeforeCancel = handle.chunksEmitted();
    expect(emittedBeforeCancel).toBeGreaterThan(0);
    expect(emittedBeforeCancel).toBeLessThan(100);

    const cancelRes = await handleCancelRequest(signedCancel(runId), {
      bearerSecret: SECRET,
      seenNonce: () => false,
    });
    expect(cancelRes.status).toBe(204);

    // The stream should close quickly. Race the drain against a safety
    // timeout — a hang here means the abort never propagated.
    const drained = await Promise.race([
      drainPromise.then(() => "drained"),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 2000)),
    ]);
    expect(drained).toBe("drained");

    // The stream must terminate cleanly with `done`, and the harness must
    // have stopped well short of the 100 it would have emitted otherwise.
    const events = collected
      .split("\n\n")
      .filter((s) => s.startsWith("data: "))
      .map((s) => s.slice("data: ".length));
    expect(events.at(-1)).toBe('{"type":"done"}');
    expect(handle.chunksEmitted()).toBeLessThan(100);
  });

  it("DELETE for an unknown runId returns 204 (idempotent)", async () => {
    const res = await handleCancelRequest(signedCancel("run-never-existed"), {
      bearerSecret: SECRET,
      seenNonce: () => false,
    });
    expect(res.status).toBe(204);
  });

  it("DELETE with a bad HMAC signature returns 401", async () => {
    const path = "/_sandbox/runs/run-bad-sig";
    const sig = signRequest({
      secret: "wrong-secret-32-bytes-paddingpaddingpadding",
      method: "DELETE",
      path,
      body: "",
    });
    const req = new Request(`http://localhost${path}`, {
      method: "DELETE",
      headers: { ...sig },
    });
    const res = await handleCancelRequest(req, {
      bearerSecret: SECRET,
      seenNonce: () => false,
    });
    expect(res.status).toBe(401);
  });
});
