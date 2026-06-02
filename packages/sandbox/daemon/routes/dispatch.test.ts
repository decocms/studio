import { describe, expect, it } from "bun:test";
import { fixtures } from "../../../../apps/mesh/src/links/protocol";
import { handleCancelRequest, handleDispatchRequest } from "./dispatch";

const DAEMON_TOKEN = "test-daemon-token-32-chars-min-aaaa";

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
    daemonToken: DAEMON_TOKEN,
    lookupHarness: () => makeFakeHarness(),
    ...overrides,
  };
}

function authedDispatch(body: string, token = DAEMON_TOKEN) {
  return new Request("http://localhost/_sandbox/dispatch", {
    method: "POST",
    body,
    headers: {
      authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

function authedCancel(runId: string, token = DAEMON_TOKEN) {
  const path = `/_sandbox/runs/${runId}`;
  return new Request(`http://localhost${path}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
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
    const res = await handleDispatchRequest(authedDispatch(body), makeDeps());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await readSSE(res);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.includes('"type":"ui-message-chunk"'))).toBe(
      true,
    );
    expect(events.at(-1)).toBe('{"type":"done"}');
  });

  it("rejects a request with no bearer token", async () => {
    const req = new Request("http://x/_sandbox/dispatch", {
      method: "POST",
      body: "{}",
    });
    const res = await handleDispatchRequest(req, makeDeps());
    expect(res.status).toBe(401);
  });

  it("rejects a bearer token that does not match", async () => {
    const body = JSON.stringify({
      harnessId: "fake",
      input: { ...fixtures.FIXTURE_MINIMAL_INPUT, runId: "run-token-2" },
    });
    const res = await handleDispatchRequest(
      authedDispatch(body, "wrong-token"),
      makeDeps(),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid input shape", async () => {
    const body = JSON.stringify({ harnessId: "fake", input: { bogus: true } });
    const res = await handleDispatchRequest(authedDispatch(body), makeDeps());
    expect(res.status).toBe(400);
  });

  it("returns 410 Gone for a tombstoned runId (cancel-before-dispatch)", async () => {
    // Cancel first — this writes a tombstone.
    const runId = "run-tombstone-1";
    const cancelRes = await handleCancelRequest(authedCancel(runId), {
      daemonToken: DAEMON_TOKEN,
    });
    expect(cancelRes.status).toBe(204);

    // Subsequent dispatch with the same runId should be rejected.
    const body = JSON.stringify({
      harnessId: "fake",
      input: { ...fixtures.FIXTURE_MINIMAL_INPUT, runId },
    });
    const res = await handleDispatchRequest(authedDispatch(body), makeDeps());
    expect(res.status).toBe(410);
  });

  it("does not crash with ERR_INVALID_STATE when the consumer cancels mid-stream", async () => {
    // Repro for the link-daemon crash: a long-lived run whose SSE consumer
    // (browser → cluster → link WS) disconnects mid-stream. The harness keeps
    // producing chunks; without a guard the writer enqueues on the now-closed
    // controller and throws "Controller is already closed", crashing the run
    // (surfaced as `harness_crashed`) instead of stopping cleanly.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let settleHarness!: () => void;
    const harnessDone = new Promise<void>((r) => {
      settleHarness = r;
    });

    const errorArgs: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      errorArgs.push(args);
    };

    try {
      const deps = makeDeps({
        lookupHarness: () => ({
          async *stream() {
            try {
              yield { type: "start", id: "m1" } as const;
              // Pause until the consumer has cancelled, then keep producing —
              // these post-cancel chunks are what used to crash the writer.
              await gate;
              for (let i = 0; i < 25; i++) {
                yield { type: "text-delta", id: "m1", delta: "x" } as const;
              }
            } finally {
              settleHarness();
            }
          },
        }),
      });

      const body = JSON.stringify({
        harnessId: "fake",
        input: {
          ...fixtures.FIXTURE_MINIMAL_INPUT,
          runId: "run-cancel-midstream",
        },
      });
      const res = await handleDispatchRequest(authedDispatch(body), deps);
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      await reader.read(); // consume the first chunk
      await reader.cancel(); // simulate consumer disconnect → stream cancel()
      release(); // let the harness produce more after the consumer is gone
      await harnessDone; // the generator's `finally` ran → loop fully unwound
      await Promise.resolve();
    } finally {
      console.error = originalConsoleError;
    }

    const crashed = errorArgs.some((args) =>
      args.some(
        (a) =>
          (typeof a === "string" && a.includes("harness crashed")) ||
          (a instanceof Error &&
            a.message.includes("Controller is already closed")),
      ),
    );
    expect(crashed).toBe(false);
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
    const res = await handleDispatchRequest(authedDispatch(body), deps);
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
    const res = await handleCancelRequest(authedCancel("run-unknown-1"), {
      daemonToken: DAEMON_TOKEN,
    });
    expect(res.status).toBe(204);
  });

  it("rejects a cancel with no bearer token", async () => {
    const path = "/_sandbox/runs/run-x";
    const req = new Request(`http://x${path}`, { method: "DELETE" });
    const res = await handleCancelRequest(req, { daemonToken: DAEMON_TOKEN });
    expect(res.status).toBe(401);
  });

  it("rejects a cancel with a non-matching bearer token", async () => {
    const res = await handleCancelRequest(
      authedCancel("run-x", "wrong-token"),
      { daemonToken: DAEMON_TOKEN },
    );
    expect(res.status).toBe(401);
  });
});
