import { describe, expect, it } from "bun:test";
import { fixtures } from "../../dispatch/index";
import {
  getTombstoneCountForTests,
  handleCancelRequest,
  handleDispatchRequest,
  resetDispatchStateForTests,
} from "./dispatch";

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
    allowedHosts: [],
    allowSameHostDev: false,
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
      runId: "run-dispatch-1",
      harnessId: "fake",
      input: {
        ...fixtures.FIXTURE_MINIMAL_INPUT,
        threadId: "thread-dispatch-1",
      },
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

  it("emits an immediate SSE prelude before the first harness chunk", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const deps = makeDeps({
      lookupHarness: () => ({
        async *stream() {
          await gate;
          yield { type: "start", id: "m1" } as const;
        },
      }),
    });
    const body = JSON.stringify({
      runId: "run-prelude",
      harnessId: "fake",
      input: { ...fixtures.FIXTURE_MINIMAL_INPUT, threadId: "thread-prelude" },
    });

    const res = await handleDispatchRequest(authedDispatch(body), deps);
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const first = await Promise.race([
      reader.read(),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 25),
      ),
    ]);

    expect(first).not.toBe("timeout");
    if (first !== "timeout") {
      expect(new TextDecoder().decode(first.value)).toBe(
        ": dispatch accepted\n\n",
      );
    }

    release();
    await reader.cancel();
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
      runId: "run-token-2",
      harnessId: "fake",
      input: { ...fixtures.FIXTURE_MINIMAL_INPUT, threadId: "thread-token-2" },
    });
    const res = await handleDispatchRequest(
      authedDispatch(body, "wrong-token"),
      makeDeps(),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid input shape", async () => {
    const body = JSON.stringify({
      runId: "run-invalid-input",
      harnessId: "fake",
      input: { bogus: true },
    });
    const res = await handleDispatchRequest(authedDispatch(body), makeDeps());
    expect(res.status).toBe(400);
  });

  it("returns 400 when the dispatch envelope has no runId", async () => {
    const body = JSON.stringify({
      harnessId: "fake",
      input: fixtures.FIXTURE_MINIMAL_INPUT,
    });
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
      runId,
      harnessId: "fake",
      input: {
        ...fixtures.FIXTURE_MINIMAL_INPUT,
        threadId: "thread-tombstone-1",
      },
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
        runId: "run-cancel-midstream",
        harnessId: "fake",
        input: {
          ...fixtures.FIXTURE_MINIMAL_INPUT,
          threadId: "thread-cancel-midstream",
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

  it("injects a live AbortSignal into the harness input (cancel aborts it)", async () => {
    // The wire input cannot carry a (non-serializable) AbortSignal, so the
    // daemon must reconstruct `input.signal` from its per-run AbortController.
    // Without this, harnesses see `input.signal === undefined` — which crashed
    // `genTitle`'s `addEventListener` and silently dropped cancellation.
    const runId = "run-signal-inject";
    let captured: { signal?: AbortSignal } | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const deps = makeDeps({
      lookupHarness: (_id, input) => {
        captured = input as { signal?: AbortSignal };
        return {
          async *stream() {
            yield { type: "start", id: "m1" } as const;
            await gate; // hold the run open so cancel can land
          },
        };
      },
    });

    const body = JSON.stringify({
      runId,
      harnessId: "fake",
      input: {
        ...fixtures.FIXTURE_MINIMAL_INPUT,
        threadId: "thread-signal-inject",
      },
    });
    const res = await handleDispatchRequest(authedDispatch(body), deps);
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    await reader.read(); // ensure start() ran → lookupHarness called

    expect(captured?.signal).toBeInstanceOf(AbortSignal);
    expect(captured?.signal?.aborted).toBe(false);

    // Cancelling the run must flip the injected signal.
    await handleCancelRequest(authedCancel(runId), {
      daemonToken: DAEMON_TOKEN,
    });
    expect(captured?.signal?.aborted).toBe(true);

    release();
    await reader.cancel();
  });

  it("does not log an aborted run's AbortError via console.error (#3763)", async () => {
    // A cancelled run (DELETE /_sandbox/runs/:id) aborts the injected signal,
    // which makes the harness's in-flight fetch/streamText throw an AbortError
    // — expected control flow, not a crash. It must not flood error tracking.
    const runId = "run-abort-no-error-log";
    let capturedSignal: AbortSignal | undefined;
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });

    const deps = makeDeps({
      lookupHarness: (_id, input) => {
        capturedSignal = (input as { signal?: AbortSignal }).signal;
        return {
          async *stream() {
            yield { type: "start", id: "m1" } as const;
            await gate;
            throw new DOMException("The operation was aborted.", "AbortError");
          },
        };
      },
    });

    const body = JSON.stringify({
      runId,
      harnessId: "fake",
      input: {
        ...fixtures.FIXTURE_MINIMAL_INPUT,
        threadId: "thread-abort-no-error-log",
      },
    });

    const errorArgs: unknown[][] = [];
    const logArgs: unknown[][] = [];
    const originalConsoleError = console.error;
    const originalConsoleLog = console.log;
    console.error = (...args: unknown[]) => {
      errorArgs.push(args);
    };
    console.log = (...args: unknown[]) => {
      logArgs.push(args);
    };

    try {
      const res = await handleDispatchRequest(authedDispatch(body), deps);
      const reader = res.body!.getReader();

      await reader.read(); // consume "start" chunk → lookupHarness ran

      await handleCancelRequest(authedCancel(runId), {
        daemonToken: DAEMON_TOKEN,
      });
      expect(capturedSignal?.aborted).toBe(true);

      releaseGate(); // let the harness throw the AbortError now

      // Once aborted, `write()` is a deliberate no-op (the consumer is gone —
      // see the guard above `streamHarnessRun`'s catch), so no further SSE
      // frames arrive; just drain until the controller closes.
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } finally {
      console.error = originalConsoleError;
      console.log = originalConsoleLog;
    }

    const crashLogged = errorArgs.some((args) =>
      args.some((a) => typeof a === "string" && a.includes("harness crashed")),
    );
    expect(crashLogged).toBe(false);

    const abortLogged = logArgs.some((args) =>
      args.some((a) => typeof a === "string" && a.includes("harness aborted")),
    );
    expect(abortLogged).toBe(true);
  });

  it("rebases symbolic workspace.cwd onto the daemon's sandbox root before the harness sees it", async () => {
    // The wire carries the symbolic value "/repo"; the daemon must rebase it
    // onto its own sandbox root (daemonAppRoot()) before handing the input to
    // the harness. The harness MUST receive the rebased absolute path, not the
    // wire symbol — so `effectiveCwd(input.workspace.cwd)` yields a real path.
    const runId = "run-cwd-rebase";
    let capturedInput: { workspace?: { cwd: string | null } } | undefined;

    const deps = makeDeps({
      lookupHarness: (_id, input) => {
        capturedInput = input as { workspace?: { cwd: string | null } };
        return makeFakeHarness();
      },
    });

    const body = JSON.stringify({
      runId,
      harnessId: "fake",
      input: {
        ...fixtures.FIXTURE_MINIMAL_INPUT,
        threadId: "thread-cwd-rebase",
        workspace: {
          cwd: "/repo",
          repo: {
            owner: "deco",
            name: "studio",
            connectedGithub: true,
          },
          branch: "main",
        },
      },
    });
    const res = await handleDispatchRequest(authedDispatch(body), deps);
    expect(res.status).toBe(200);
    await readSSE(res); // drain the stream so lookupHarness runs

    // The harness should receive the daemon's appRoot + "/repo" — NOT the bare "/repo"
    const rebasedCwd = capturedInput?.workspace?.cwd;
    expect(typeof rebasedCwd).toBe("string");
    // Must be an absolute path (not the sentinel or wire symbol)
    expect(rebasedCwd).not.toBe("default");
    expect(rebasedCwd).not.toBe("/repo");
    // Must end with /repo (rebased to the daemon's sandbox root)
    expect(rebasedCwd?.endsWith("/repo")).toBe(true);
  });

  it("passes null workspace.cwd through to the harness", async () => {
    const runId = "run-cwd-null";
    let capturedInput: { workspace?: { cwd: string | null } } | undefined;

    const deps = makeDeps({
      lookupHarness: (_id, input) => {
        capturedInput = input as { workspace?: { cwd: string | null } };
        return makeFakeHarness();
      },
    });

    const body = JSON.stringify({
      runId,
      harnessId: "fake",
      input: {
        ...fixtures.FIXTURE_MINIMAL_INPUT,
        threadId: "thread-cwd-null",
        workspace: { cwd: null },
      },
    });
    const res = await handleDispatchRequest(authedDispatch(body), deps);
    expect(res.status).toBe(200);
    await readSSE(res);

    expect(capturedInput?.workspace?.cwd).toBeNull();
  });

  it("wraps harness errors as an error SSE event followed by done", async () => {
    const harnessId = "throws";
    const body = JSON.stringify({
      runId: "run-error-1",
      harnessId,
      input: { ...fixtures.FIXTURE_MINIMAL_INPUT, threadId: "thread-error-1" },
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

  it("sweeps expired tombstones instead of growing forever", async () => {
    // Most cancelled runs are never re-dispatched, so the only other read
    // site (the dispatch handler's own-runId check) never fires for them.
    // Without a sweep, every cancel the daemon ever handles leaks one entry
    // for the lifetime of the process.
    resetDispatchStateForTests();
    const originalNow = Date.now;
    try {
      let now = 1_000_000;
      Date.now = () => now;

      await handleCancelRequest(authedCancel("run-leak-1"), {
        daemonToken: DAEMON_TOKEN,
      });
      expect(getTombstoneCountForTests()).toBe(1);

      now += 61_000; // past the 60s tombstone TTL
      await handleCancelRequest(authedCancel("run-leak-2"), {
        daemonToken: DAEMON_TOKEN,
      });
      // run-leak-1's entry expired and was swept; only the fresh one remains.
      expect(getTombstoneCountForTests()).toBe(1);
    } finally {
      Date.now = originalNow;
    }
  });
});
