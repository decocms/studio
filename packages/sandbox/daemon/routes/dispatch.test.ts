import { describe, expect, it } from "bun:test";
import {
  fixtures,
  signRequest,
} from "../../../../apps/mesh/src/links/protocol";
import { handleCancelRequest, handleDispatchRequest } from "./dispatch";

const SECRET = "test-secret-32-bytes-padding-padding-padding";

function makeFakeHarness() {
  return {
    async *stream() {
      yield { type: "start", id: "m1" } as const;
      yield { type: "text-delta", id: "m1", delta: "hello" } as const;
      yield { type: "finish", finishReason: "stop" } as const;
    },
  };
}

function makeDeps(
  overrides: Partial<Parameters<typeof handleDispatchRequest>[1]> = {},
) {
  return {
    bearerSecret: SECRET,
    lookupHarness: () => makeFakeHarness(),
    seenNonce: () => false,
    ...overrides,
  };
}

function signedDispatch(body: string) {
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

function signedCancel(runId: string) {
  const path = `/_sandbox/runs/${runId}`;
  const sig = signRequest({ secret: SECRET, method: "DELETE", path, body: "" });
  return new Request(`http://localhost${path}`, {
    method: "DELETE",
    headers: { ...sig },
  });
}

async function readSSE(res: Response): Promise<string[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((s) => s.startsWith("data: "))
    .map((s) => s.slice("data: ".length));
}

describe("POST /_sandbox/dispatch", () => {
  it("emits the harness's UIMessageChunks as SSE", async () => {
    const body = JSON.stringify({
      harnessId: "fake",
      input: { ...fixtures.FIXTURE_MINIMAL_INPUT, runId: "run-dispatch-1" },
    });
    const res = await handleDispatchRequest(signedDispatch(body), makeDeps());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await readSSE(res);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.includes('"type":"ui-message-chunk"'))).toBe(
      true,
    );
    expect(events.at(-1)).toBe('{"type":"done"}');
  });

  it("rejects an unsigned request", async () => {
    const req = new Request("http://x/_sandbox/dispatch", {
      method: "POST",
      body: "{}",
    });
    const res = await handleDispatchRequest(req, makeDeps());
    expect(res.status).toBe(401);
  });

  it("rejects a bad signature", async () => {
    const body = JSON.stringify({ harnessId: "fake", input: {} });
    const sig = signRequest({
      secret: "wrong-secret-32-bytes-paddingpadding",
      method: "POST",
      path: "/_sandbox/dispatch",
      body,
    });
    const req = new Request("http://localhost/_sandbox/dispatch", {
      method: "POST",
      body,
      headers: { ...sig, "Content-Type": "application/json" },
    });
    const res = await handleDispatchRequest(req, makeDeps());
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid input shape", async () => {
    const body = JSON.stringify({ harnessId: "fake", input: { bogus: true } });
    const res = await handleDispatchRequest(signedDispatch(body), makeDeps());
    expect(res.status).toBe(400);
  });

  it("returns 410 Gone for a tombstoned runId (cancel-before-dispatch)", async () => {
    // Cancel first — this writes a tombstone.
    const runId = "run-tombstone-1";
    const cancelRes = await handleCancelRequest(signedCancel(runId), {
      bearerSecret: SECRET,
      seenNonce: () => false,
    });
    expect(cancelRes.status).toBe(204);

    // Subsequent dispatch with the same runId should be rejected.
    const body = JSON.stringify({
      harnessId: "fake",
      input: { ...fixtures.FIXTURE_MINIMAL_INPUT, runId },
    });
    const res = await handleDispatchRequest(signedDispatch(body), makeDeps());
    expect(res.status).toBe(410);
  });

  it("wraps harness errors as an error SSE event followed by done", async () => {
    const harnessId = "throws";
    const body = JSON.stringify({
      harnessId,
      input: { ...fixtures.FIXTURE_MINIMAL_INPUT, runId: "run-error-1" },
    });
    const deps = makeDeps({
      lookupHarness: () => ({
        async *stream() {
          throw new Error("boom");
          // biome-ignore lint/correctness/useYield: unreachable
          yield 0 as never;
        },
      }),
    });
    const res = await handleDispatchRequest(signedDispatch(body), deps);
    expect(res.status).toBe(200);
    const events = await readSSE(res);
    const errorEvent = events.find((e) => e.includes('"type":"error"'));
    expect(errorEvent).toBeDefined();
    expect(errorEvent).toContain("boom");
    expect(events.at(-1)).toBe('{"type":"done"}');
  });
});

describe("DELETE /_sandbox/runs/:runId", () => {
  it("returns 204 even for an unknown runId (idempotent)", async () => {
    const res = await handleCancelRequest(signedCancel("run-unknown-1"), {
      bearerSecret: SECRET,
      seenNonce: () => false,
    });
    expect(res.status).toBe(204);
  });

  it("rejects an unsigned cancel", async () => {
    const path = "/_sandbox/runs/run-x";
    const req = new Request(`http://x${path}`, { method: "DELETE" });
    const res = await handleCancelRequest(req, {
      bearerSecret: SECRET,
      seenNonce: () => false,
    });
    expect(res.status).toBe(401);
  });
});
