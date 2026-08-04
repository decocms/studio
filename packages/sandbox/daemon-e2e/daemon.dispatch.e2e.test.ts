/**
 * Daemon conformance suite — DISPATCH + RUN CANCEL.
 *
 * Contract-only: a real harness run needs model providers/MCP and can't run in
 * CI, so we assert the deterministic gates that fire BEFORE the harness streams
 * (auth, body validation, cancel/tombstone). `/dispatch` and `/runs/:id` verify
 * the bearer in-handler (not via the shared requireToken middleware), so the
 * 401 cases are exercised here too.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";

import {
  authHeaders,
  type Daemon,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  startDaemon,
  stopDaemon,
  url,
} from "./daemon.e2e.helpers";

const toBody = (obj: unknown) => JSON.stringify(obj);

/**
 * One frame of the dispatch response, inlined: this suite owns its wire
 * contract. The body is newline-delimited frames — blank lines are the daemon's
 * keepalive — and only the last one can carry `error`.
 *
 * `done` flags that last frame. The daemon always sends one, so a body that ends
 * without it tells the consumer the connection died rather than the run.
 */
interface DispatchFrame {
  chunks: unknown[];
  done?: boolean;
  error?: { code: string; message: string } | null;
}

/** Read the response body frame by frame, with the moment each one arrived. */
async function* readFrames(
  res: Response,
): AsyncIterable<{ frame: DispatchFrame; at: number }> {
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      yield { frame: JSON.parse(line) as DispatchFrame, at: Date.now() };
    }
  }
  if (buffer.trim().length > 0) {
    yield { frame: JSON.parse(buffer) as DispatchFrame, at: Date.now() };
  }
}

/** The smallest envelope the daemon accepts (see `ValidateHarnessInput`). */
const VALID_INPUT = {
  threadId: "thrd_e2e",
  userMessage: { role: "user" },
  harness: {},
  // `cwd: "/repo"` is the only accepted path, and it obliges the repo it names.
  workspace: {
    cwd: "/repo",
    repo: { owner: "o", name: "n", connectedGithub: false },
    branch: null,
  },
  models: { thinking: { id: "m", title: "M", credentialId: "c" } },
  mcp: { url: "https://example.com/mcp", headers: {}, expiresAt: 123 },
  mode: "default",
  temperature: 0.5,
  toolApprovalLevel: "auto",
  user: { id: "u", email: "u@example.com" },
  organizationId: "org",
  agent: { id: "a" },
};

/** Spawn command for the stub harness, in the mode under test. */
const stubHarnessCmd = () =>
  JSON.stringify(["node", join(import.meta.dir, "stub-harness.mjs")]);

describe("daemon e2e: dispatch", () => {
  let d: Daemon;
  beforeAll(async () => {
    d = await startDaemon();
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await stopDaemon(d);
  }, HOOK_TIMEOUT_MS);

  it("POST /dispatch without bearer → 401", async () => {
    const res = await fetch(url(d, "/_sandbox/dispatch"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: toBody({ harnessId: "x", input: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /dispatch with invalid JSON → 400 bad_json", async () => {
    const res = await fetch(url(d, "/_sandbox/dispatch"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: "}{nope",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_json");
  });

  it("POST /dispatch with a non-string harnessId → 400 missing_harness_id", async () => {
    const res = await fetch(url(d, "/_sandbox/dispatch"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ harnessId: 123, input: {} }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "missing_harness_id",
    );
  });

  it("POST /dispatch without runId → 400 missing_run_id", async () => {
    const res = await fetch(url(d, "/_sandbox/dispatch"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ harnessId: "claude-code", input: {} }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "missing_run_id",
    );
  });

  it("POST /dispatch with a malformed input envelope → 400 bad_input", async () => {
    const res = await fetch(url(d, "/_sandbox/dispatch"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({
        runId: "run-bad-input",
        harnessId: "claude-code",
        input: {},
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_input");
  });

  it("POST /dispatch with no harness configured → 200 with an error result", async () => {
    // The gates above answer with a status code; once the envelope is valid the
    // route always answers 200 with a HarnessRunResult, so a run that produced
    // nothing is still `{chunks, error}` and not an HTTP failure.
    const res = await fetch(url(d, "/_sandbox/dispatch"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({
        runId: "run-no-harness",
        harnessId: "claude-code",
        input: VALID_INPUT,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      chunks: [],
      done: true,
      error: { code: "unknown_harness", message: expect.any(String) },
    });
  });

  it("DELETE /runs/:id with bearer → 204 (idempotent for unknown runs)", async () => {
    const res = await fetch(url(d, "/_sandbox/runs/unknown-run-id"), {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.status).toBe(204);
  });

  it("DELETE /runs/:id without bearer → 401", async () => {
    const res = await fetch(url(d, "/_sandbox/runs/some-run"), {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("DELETE /runs/ without a run id → 404", async () => {
    const res = await fetch(url(d, "/_sandbox/runs/"), {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });
});

/**
 * The dispatch response contract, driven through a real harness process.
 *
 * The stub speaks the harness wire (`stub-harness.mjs`) instead of running a
 * model, so these assert what the daemon guarantees regardless of harness: the
 * result JSON, the rebased `cwd`, the per-run env, and that a harness which dies
 * still answers 200 with an error rather than an HTTP failure.
 */
describe("daemon e2e: dispatch runs a harness", () => {
  let d: Daemon;
  beforeAll(async () => {
    d = await startDaemon({ HARNESS_RUNNER_CMD: stubHarnessCmd() });
    // Pushed on the config channel the way Studio pushes the model credential.
    const cfg = await fetch(url(d, "/_sandbox/config"), {
      method: "PUT",
      headers: jsonAuthHeaders(),
      body: toBody({ env: { ANTHROPIC_API_KEY: "sk-e2e" } }),
    });
    expect(cfg.ok).toBe(true);
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await stopDaemon(d);
  }, HOOK_TIMEOUT_MS);

  /** Dispatch one run, asking the stub for `mode`. */
  const dispatch = (mode: string, runId: string) =>
    fetch(url(d, "/_sandbox/dispatch"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({
        runId,
        harnessId: "claude-code",
        input: { ...VALID_INPUT, harness: { stubMode: mode } },
      }),
    });

  /** Every frame of one run, flattened the way a consumer folds them. */
  async function result(
    mode: string,
    runId: string,
  ): Promise<{
    chunks: unknown[];
    error: DispatchFrame["error"];
    done: boolean;
    at: number[];
  }> {
    const res = await dispatch(mode, runId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const chunks: unknown[] = [];
    const at: number[] = [];
    let error: DispatchFrame["error"] = null;
    let done = false;
    for await (const { frame, at: arrivedAt } of readFrames(res)) {
      chunks.push(...frame.chunks);
      at.push(arrivedAt);
      // First reason wins: the harness's own error frame precedes the daemon's
      // terminal, and the terminal carries none of its own on that path.
      error ??= frame.error ?? null;
      if (frame.done) done = true;
    }
    return { chunks, error, done, at };
  }

  it(
    "answers with the harness's chunks, the rebased cwd and the run env",
    async () => {
      const body = await result("ok", "run-ok");
      expect(body.error).toBeNull();
      // A finished run always says so — that is what stops a consumer from
      // continuing a turn that already ended.
      expect(body.done).toBe(true);
      expect(body.chunks).toHaveLength(1);
      const echoed = JSON.parse(
        (body.chunks[0] as { delta: string }).delta,
      ) as Record<string, unknown>;
      expect(echoed.harnessId).toBe("claude-code");
      expect(echoed.threadId).toBe("thrd_e2e");
      // `/repo` is rebased onto the pod's app root before the harness sees it.
      expect(echoed.cwd).toMatch(/\/repo$/);
      expect(echoed.cwd).not.toBe("/repo");
      // The model credential reaches the harness as its spawn env.
      expect(echoed.apiKey).toBe("sk-e2e");
    },
    HOOK_TIMEOUT_MS,
  );

  it(
    "a harness that dies is a 200 error result, not an HTTP failure",
    async () => {
      const body = await result("crash", "run-crash");
      expect(body.chunks).toEqual([]);
      expect(body.error?.code).toBe("harness_crashed");
      // Terminal, and flagged as such: a crash is the run ending, not the
      // connection dropping, so the consumer must report it rather than retry.
      expect(body.done).toBe(true);
    },
    HOOK_TIMEOUT_MS,
  );

  it(
    "ignores unrelated output on the harness's stdout",
    async () => {
      const body = await result("noisy", "run-noisy");
      expect(body.error).toBeNull();
      expect(body.chunks).toHaveLength(1);
    },
    HOOK_TIMEOUT_MS,
  );

  it(
    "forwards each frame as the harness prints it, not at the end of the run",
    async () => {
      const body = await result("frames", "run-frames");
      expect(body.error).toBeNull();
      expect(body.chunks).toHaveLength(3);
      // Spaced by the stub, so arriving together means the daemon buffered.
      expect(body.at.at(-1)! - body.at[0]!).toBeGreaterThan(20);
    },
    HOOK_TIMEOUT_MS,
  );

  it(
    "streaming keeps the pod's idle clock reset, so a long run isn't reaped",
    async () => {
      // `activity.Bump()` fires on the dispatch REQUEST too, so the run has to
      // outlast the window we then assert on — hence the spaced-out stub. Without
      // a per-frame bump the daemon reports a run that has been streaming for
      // seconds as untouched since its request arrived, and the operator's idle
      // reaper deletes the pod mid-turn.
      const startedAt = Date.now();
      const body = await result("slow", "run-slow");
      expect(body.done).toBe(true);
      expect(body.chunks).toHaveLength(4);
      const ran = Date.now() - startedAt;
      expect(ran).toBeGreaterThan(1_200);

      const idle = (await (await fetch(url(d, "/_sandbox/idle"))).json()) as {
        idleMs: number;
      };
      // Idle since the LAST frame, not since the dispatch began.
      expect(idle.idleMs).toBeLessThan(ran);
      expect(idle.idleMs).toBeLessThan(800);
    },
    HOOK_TIMEOUT_MS,
  );

  it(
    "a re-dispatch of a live run takes it over instead of running a second harness",
    async () => {
      // This is what Studio sends when the pod driving a run died and another
      // picked the work up: same runId, a fresh request. Two `claude` processes
      // in one checkout is the failure being prevented — the displaced run must
      // be gone before the replacement's harness starts.
      const runId = "run-takeover";
      const first = dispatch("hang", runId);
      const firstRes = await first;
      expect(firstRes.status).toBe(200);

      // Read the displaced run's body in the background so we learn exactly when
      // the daemon ended it, and with what.
      const displaced = (async () => {
        const frames: DispatchFrame[] = [];
        let endedAt = 0;
        for await (const { frame } of readFrames(firstRes)) frames.push(frame);
        endedAt = Date.now();
        return { frames, endedAt };
      })();

      // Let the daemon exec the hanging harness before displacing it.
      await new Promise((r) => setTimeout(r, 500));

      const secondRes = await dispatch("frames", runId);
      expect(secondRes.status).toBe(200);
      let secondFirstFrameAt = 0;
      const secondChunks: unknown[] = [];
      let secondDone = false;
      for await (const { frame, at } of readFrames(secondRes)) {
        secondFirstFrameAt ||= at;
        secondChunks.push(...frame.chunks);
        if (frame.done) secondDone = true;
      }

      const { frames, endedAt } = await displaced;
      // The displaced run ended, and said why — it did not outlive the takeover.
      const terminal = frames.at(-1);
      expect(terminal?.done).toBe(true);
      expect(terminal?.error?.code).toBe("cancelled");
      // And it ended BEFORE the replacement produced anything: the daemon waits
      // for the old process group to die before exec'ing the new harness.
      expect(secondFirstFrameAt).toBeGreaterThanOrEqual(endedAt);
      // The replacement ran to completion on its own.
      expect(secondChunks).toHaveLength(3);
      expect(secondDone).toBe(true);
    },
    HOOK_TIMEOUT_MS,
  );

  it(
    "cancelling a run kills the harness instead of waiting for it",
    async () => {
      const started = Date.now();
      const run = dispatch("hang", "run-hang");
      // Let the daemon exec the harness before cancelling it.
      await new Promise((r) => setTimeout(r, 500));
      const cancel = await fetch(url(d, "/_sandbox/runs/run-hang"), {
        method: "DELETE",
        headers: authHeaders(),
      });
      expect(cancel.status).toBe(204);
      // The dispatch ends with the run — either a dropped connection or an
      // answered request, but never by outliving the cancel.
      await run.then(
        (res) => res.body?.cancel(),
        () => undefined,
      );
      expect(Date.now() - started).toBeLessThan(20_000);
    },
    HOOK_TIMEOUT_MS,
  );
});
