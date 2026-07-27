/**
 * local-api e2e: full dispatch STREAMING acceptance, vs the local-api binary
 * with `LOCAL_API_CLAUDE_BIN` pointed at the deterministic fake `claude` CLI
 * (`apps/native/e2e/fixtures/stub-harness.mjs`).
 *
 * Scope split from `dispatch.e2e.test.ts` (which pins the pre-stream GATES —
 * 401/bad_json/missing_harness_id/missing_run_id/bad_input — and doesn't
 * need a real harness binary at all): this file exercises what happens
 * AFTER the gates pass, i.e. an actual harness process gets spawned and
 * streamed. See the desktop migration contract §2.2/§2.3 and
 * the native local-API contract.
 *
 * EXPECTED TO FAIL until the Rust harness crate (`apps/native/crates/
 * harness`, the desktop migration contract §2.1) lands `LOCAL_API_CLAUDE_BIN` resolution,
 * PTY spawn, and stream translation. That is the documented SHARED CONTRACT
 * this suite is written against, not this suite's in-progress companion
 * code — see the module-level comment in `helpers.ts::stubClaudeBinEnv`.
 * Every assertion below cites the exact contract-doc line it pins so a
 * failure is legible as "not implemented yet" vs "implemented wrong."
 *
 * STRICTNESS LEVEL: the contract doc explicitly marks a dispatch chunk's
 * payload `<opaque UIMessageChunk>` (the native local-API contract,
 * "one per harness output chunk"). This suite therefore asserts the ENVELOPE
 * byte-for-byte (SSE framing, event-type sequence, terminal invariants) —
 * the part the contract doc actually pins — and treats `chunk`'s internal
 * shape as opaque, exactly like the contract does. It does NOT assert an
 * exact `ui-message-chunk` COUNT per scenario, because the raw CLI ndjson
 * line count (pinned exactly by the stub's own header comment) and the
 * SSE-level chunk count are related by a Rust-side translation step this
 * suite has no visibility into — see the native parity contract's
 * Phase 2 section for the full reasoning and the allowlist this implies.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { retry } from "@decocms/shared/std";
import { afterAll, beforeAll, expect, it } from "bun:test";

import {
  authHeaders,
  buildDispatchInput,
  createThread,
  describeLocalApi,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  listMessages,
  listRuns,
  type LocalApi,
  parseDispatchFrames,
  readSseUntil,
  runDispatchToCompletion,
  startLocalApi,
  stopLocalApi,
  stubClaudeBinEnv,
  url,
} from "./helpers";

/** A run id unique enough not to collide across tests sharing one instance. */
let runCounter = 0;
function freshRunId(tag: string): string {
  runCounter += 1;
  return `run-${tag}-${runCounter}`;
}

interface StubLifecycleRecord {
  pid: number;
  scenario?: string;
  ownership?: string;
  signal?: "SIGTERM";
  at?: number;
}

function readJsonLines(path: string): StubLifecycleRecord[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StubLifecycleRecord);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

const LIFECYCLE_RETRY_OPTIONS = {
  maxAttempts: 100,
  minTimeout: 20,
  maxTimeout: 100,
  jitter: 0,
} as const;

describeLocalApi("local-api e2e: dispatch streaming (stub harness)", () => {
  let a: LocalApi;
  let lifecycleDir: string;
  let invocationLog: string;
  let signalLog: string;
  beforeAll(async () => {
    // Every test in this file needs the stub wired in, so it's simplest to
    // spin up ONE instance for the whole file rather than per-test (mirrors
    // the daemon suite's convention of one daemon per describe block).
    lifecycleDir = mkdtempSync(join(tmpdir(), "dispatch-lifecycle-"));
    invocationLog = join(lifecycleDir, "invocations.jsonl");
    signalLog = join(lifecycleDir, "signals.jsonl");
    a = await startLocalApi(
      stubClaudeBinEnv({
        STUB_HARNESS_INVOCATION_LOG: invocationLog,
        STUB_HARNESS_SIGNAL_LOG: signalLog,
      }),
    );
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await stopLocalApi(a);
    rmSync(lifecycleDir, { recursive: true, force: true });
  }, HOOK_TIMEOUT_MS);

  // ── Happy path ────────────────────────────────────────────────────────

  it("happy path: exact SSE envelope framing, in order (contract: SSE framing + Dispatch lifecycle)", async () => {
    const thread = await createThread(a, "happy path");
    const runId = freshRunId("simple");
    const res = await fetch(url(a, "/_sandbox/dispatch"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        runId,
        harnessId: "claude-code",
        input: buildDispatchInput({
          threadId: thread.id,
          prompt: "SCENARIO:simple",
        }),
      }),
    });

    // Response-level framing, byte-parity target per "Stream (once gates
    // pass)" in the native local-API contract.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("connection")).toBe("keep-alive");

    const rawText = await res.text();

    // "one leading SSE comment line `: dispatch accepted\n\n` before the
    // first data frame" (contract doc, SSE framing section) — byte-exact,
    // and strictly BEFORE the first `data:` line.
    const commentIdx = rawText.indexOf(": dispatch accepted\n\n");
    const firstDataIdx = rawText.indexOf("data:");
    expect(commentIdx).toBeGreaterThanOrEqual(0);
    expect(firstDataIdx).toBeGreaterThan(commentIdx);

    // DATA-ONLY framing: no `event:` line anywhere in the body (contract:
    // "DATA-ONLY (no `event:` header — the default SSE event name `message`
    // applies)").
    expect(rawText).not.toContain("event:");

    const frames = parseDispatchFrames(rawText);

    // Exact contract framing events, IN ORDER: zero or more
    // `ui-message-chunk`, then exactly one `done`, last, no `error` at all
    // on the happy path.
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.at(-1)).toEqual({ type: "done" });
    expect(frames.filter((f) => f.type === "done").length).toBe(1);
    expect(frames.filter((f) => f.type === "error").length).toBe(0);
    expect(
      frames.slice(0, -1).every((f) => f.type === "ui-message-chunk"),
    ).toBe(true);
  });

  // ── Failure scenario ─────────────────────────────────────────────────

  it("failure scenario: error chunk + done, run marked failed (contract: error event 'harness_crashed')", async () => {
    const thread = await createThread(a, "failure scenario");
    const runId = freshRunId("fail");
    const { res, frames } = await runDispatchToCompletion(a, {
      runId,
      harnessId: "claude-code",
      input: buildDispatchInput({
        threadId: thread.id,
        prompt: "SCENARIO:fail",
      }),
    });
    expect(res.status).toBe(200);

    // "at most once, if the harness throws mid-stream" + "code is
    // 'harness_crashed' for v1 desktop" (contract doc, Dispatch lifecycle).
    const errorFrames = frames.filter((f) => f.type === "error");
    expect(errorFrames.length).toBe(1);
    expect(errorFrames[0]).toMatchObject({
      type: "error",
      code: "harness_crashed",
    });
    expect(typeof (errorFrames[0] as { message: string }).message).toBe(
      "string",
    );

    // "done — always emitted exactly once, last event ... even after an
    // error" (contract doc).
    expect(frames.at(-1)).toEqual({ type: "done" });
    expect(frames.filter((f) => f.type === "done").length).toBe(1);

    // Thread persistence: the run row lands terminal + failed. See this
    // file's top-of-file "thread persistence" design note in
    // dispatch-stream's sibling test below for the assumption this rests
    // on (dispatch auto-correlates to threadId — no separate REST call
    // documented for writing Run rows in Phase 2).
    const runs = await listRuns(a, thread.id);
    const run = runs.find((r) => r.id === runId);
    expect(run).toBeDefined();
    expect(run?.status).toBe("failed");
    expect(run?.error).not.toBeNull();
    expect(run?.ended_at).not.toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "fatal frame reaps a TERM-resistant harness before releasing the active slot",
    async () => {
      const thread = await createThread(a, "fatal process reap");
      const runId = freshRunId("fatalhang");
      const ownership = `dispatch-fatal-${randomUUID()}`;
      const { res, frames } = await runDispatchToCompletion(a, {
        runId,
        harnessId: "claude-code",
        input: buildDispatchInput({
          threadId: thread.id,
          prompt: `SCENARIO:fatalhang OWNERSHIP:${ownership}`,
        }),
      });
      expect(res.status).toBe(200);
      expect(frames.at(-1)).toEqual({ type: "done" });

      const invocation = await retry(async () => {
        const value = readJsonLines(invocationLog).find(
          (entry) => entry.ownership === ownership,
        );
        if (!value) throw new Error("fatal-hanging harness was not recorded");
        return value;
      }, LIFECYCLE_RETRY_OPTIONS);
      const aliveAfterResponse = processIsAlive(invocation.pid);
      // Keep a failing regression from leaking its deliberately stubborn
      // fixture into the developer's machine or the rest of the suite.
      if (aliveAfterResponse) process.kill(invocation.pid, "SIGKILL");
      expect(
        aliveAfterResponse,
        "dispatch returned and released its active slot before process reap",
      ).toBe(false);
      expect(
        readJsonLines(signalLog).some(
          (entry) => entry.pid === invocation.pid && entry.signal === "SIGTERM",
        ),
      ).toBe(true);
    },
    15_000,
  );

  // ── Abort mid-stream ──────────────────────────────────────────────────

  it("abort mid-stream: cancel kills the process, run marked cancelled (contract: DELETE /_sandbox/runs/:id)", async () => {
    const thread = await createThread(a, "abort mid-stream");
    const runId = freshRunId("slow");

    // Read only until the FIRST ui-message-chunk lands (i.e. mid-stream —
    // the stub's `slow` scenario spaces 3 chunks 400ms apart, see
    // fixtures/stub-harness.mjs's header comment), then cancel.
    const { res: firstChunkRes } = await readSseUntil(
      url(a, "/_sandbox/dispatch"),
      {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({
          runId,
          harnessId: "claude-code",
          input: buildDispatchInput({
            threadId: thread.id,
            prompt: "SCENARIO:slow",
          }),
        }),
        predicate: (acc) => acc.includes('"type":"ui-message-chunk"'),
        deadlineMs: 5000,
      },
    );
    expect(firstChunkRes.status).toBe(200);

    // Cancel: "204 no body, idempotent ... aborts the harness's
    // AbortSignal if running" (contract doc, Dispatch lifecycle).
    const cancelRes = await fetch(url(a, `/_sandbox/runs/${runId}`), {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(cancelRes.status).toBe(204);
    expect(await cancelRes.text()).toBe("");

    // Terminal status lands even though the client walked away mid-stream —
    // poll briefly since the harness process teardown + Run-row write race
    // with this assertion (no synchronous signal ties them together from
    // the client's vantage point).
    const deadline = Date.now() + 5000;
    let run: Awaited<ReturnType<typeof listRuns>>[number] | undefined;
    while (Date.now() < deadline) {
      const runs = await listRuns(a, thread.id);
      run = runs.find((r) => r.id === runId);
      if (run && run.status !== "pending" && run.status !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(run).toBeDefined();
    expect(run?.status).toBe("cancelled");
    expect(run?.ended_at).not.toBeNull();
  });

  // ── Hang scenario ─────────────────────────────────────────────────────

  it("hang scenario: a never-exiting harness is killed by cancel (process group teardown)", async () => {
    const thread = await createThread(a, "hang scenario");
    const runId = freshRunId("hang");

    // The `hang` scenario emits exactly one system/init line and then never
    // exits — wait for that one line, then cancel. If cancel does NOT kill
    // the process group, this test's `afterAll`/next test would otherwise
    // leak a permanently-hung child process for the rest of the suite run.
    const { res } = await readSseUntil(url(a, "/_sandbox/dispatch"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        runId,
        harnessId: "claude-code",
        input: buildDispatchInput({
          threadId: thread.id,
          prompt: "SCENARIO:hang",
        }),
      }),
      predicate: (acc) => acc.length > 0,
      deadlineMs: 5000,
    });
    expect(res.status).toBe(200);

    const cancelRes = await fetch(url(a, `/_sandbox/runs/${runId}`), {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(cancelRes.status).toBe(204);

    const deadline = Date.now() + 5000;
    let run: Awaited<ReturnType<typeof listRuns>>[number] | undefined;
    while (Date.now() < deadline) {
      const runs = await listRuns(a, thread.id);
      run = runs.find((r) => r.id === runId);
      if (run && run.status !== "pending" && run.status !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(run?.status).toBe("cancelled");

    // A racing dispatch on the SAME runId within the 60s tombstone window
    // must resolve 410, proving the process is actually gone (not just
    // logically cancelled) — "writes a 60s tombstone so a dispatch racing
    // in after the cancel resolves 410 instead of starting a doomed
    // process" (contract doc).
    const raceRes = await fetch(url(a, "/_sandbox/dispatch"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        runId,
        harnessId: "claude-code",
        input: buildDispatchInput({
          threadId: thread.id,
          prompt: "SCENARIO:simple",
        }),
      }),
    });
    expect(raceRes.status).toBe(410);
    expect(((await raceRes.json()) as { error: string }).error).toBe(
      "tombstoned",
    );
  });

  // ── Thread persistence (happy path) ─────────────────────────────────

  it("thread persistence: after a successful run, GET thread shows messages + terminal status", async () => {
    const thread = await createThread(a, "persisted thread");
    const runId = freshRunId("persist");

    // ASSUMPTION (documented — see this file's top-of-file comment and
    // the native local-API contract's "Run …
    // written by whoever is consuming the dispatch SSE stream on the run's
    // behalf, not by the dispatch route itself"): for a dispatch whose
    // `input.threadId` names an EXISTING local thread, local-api's own
    // process persists the resulting assistant message and a terminal Run
    // row keyed by `runId` WITHOUT any additional REST call — the contract
    // doc pins the Run/Message shapes and the "route itself doesn't write"
    // constraint, but does not document a separate write path, and the
    // routes table has no POST for creating a Run row. If Phase 2 lands a
    // different mechanism (e.g. the desktop frontend must itself POST
    // /threads/:id/messages and a run-tracking call around dispatch), this
    // test's assumption — not the dispatch/SSE assertions elsewhere in this
    // file — is what needs updating.
    const { res, frames } = await runDispatchToCompletion(a, {
      runId,
      harnessId: "claude-code",
      input: buildDispatchInput({
        threadId: thread.id,
        prompt: "SCENARIO:simple",
      }),
    });
    expect(res.status).toBe(200);
    expect(frames.at(-1)).toEqual({ type: "done" });

    const messages = await listMessages(a, thread.id);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m) => m.role === "assistant")).toBe(true);

    const runs = await listRuns(a, thread.id);
    const run = runs.find((r) => r.id === runId);
    expect(run).toBeDefined();
    expect(run?.harness_id).toBe("claude-code");
    expect(run?.status).toBe("completed");
    expect(run?.error).toBeNull();
    expect(run?.ended_at).not.toBeNull();

    // GET /threads/:id itself reflects the activity via updated_at bump —
    // "bumps the thread's updated_at" is documented for message POSTs
    // (contract doc, Threads routes table); a terminal run is exactly such
    // an append under this test's assumption above.
    const threadRes = await fetch(url(a, `/threads/${thread.id}`), {
      headers: jsonAuthHeaders(),
    });
    expect(threadRes.status).toBe(200);
    const threadBody = (await threadRes.json()) as {
      thread: { updated_at: string };
    };
    expect(threadBody.thread.updated_at >= thread.updated_at).toBe(true);
  });

  // ── Models endpoint reflects the stub ───────────────────────────────

  it("GET /models reflects the stub as a detected claude-code harness", async () => {
    const res = await fetch(url(a, "/models"), { headers: jsonAuthHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      harnesses: { harness: string; detected: boolean; tiers: unknown[] }[];
    };
    const claude = body.harnesses.find((h) => h.harness === "claude-code");
    expect(claude).toBeDefined();
    // Detection probes the configured LOCAL_API_CLAUDE_BIN (this instance's
    // stub), NOT a real PATH lookup — see the native local-API contract
    // --tiers-endpoint's "detected: CLI binary found ... + logged-in, via
    // the harness's own session-probe." The stub's `--version` always
    // succeeds (see fixtures/stub-harness.mjs), so this must be `true`
    // regardless of whether a real `claude` happens to be on the test
    // runner's PATH.
    expect(claude?.detected).toBe(true);
    expect(claude?.tiers.length ?? 0).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === "win32")(
    "SIGTERM closes admission and concurrently reaps every active legacy dispatch",
    async () => {
      const ownerships = [
        `dispatch-shutdown-a-${randomUUID()}`,
        `dispatch-shutdown-b-${randomUUID()}`,
      ];
      const responses = await Promise.all(
        ownerships.map((ownership, index) =>
          fetch(url(a, "/_sandbox/dispatch"), {
            method: "POST",
            headers: jsonAuthHeaders(),
            body: JSON.stringify({
              runId: freshRunId(`shutdown-${index}`),
              harnessId: "claude-code",
              input: buildDispatchInput({
                threadId: `dispatch-shutdown-thread-${index}`,
                prompt: `SCENARIO:termresist OWNERSHIP:${ownership}`,
              }),
            }),
          }),
        ),
      );
      expect(responses.map(({ status }) => status)).toEqual([200, 200]);

      const children = await retry(async () => {
        const values = readJsonLines(invocationLog).filter(
          (entry) =>
            entry.scenario === "termresist" &&
            ownerships.includes(entry.ownership ?? ""),
        );
        if (
          values.length !== 2 ||
          values.some((entry) => !processIsAlive(entry.pid))
        ) {
          throw new Error(
            `two active legacy dispatches are not ready: ${JSON.stringify(values)}`,
          );
        }
        return values;
      }, LIFECYCLE_RETRY_OPTIONS);

      expect(a.proc.kill("SIGTERM")).toBe(true);
      const shutdownSignals = await retry(async () => {
        const values = readJsonLines(signalLog).filter((entry) =>
          children.some((child) => child.pid === entry.pid),
        );
        if (values.length !== 2) {
          throw new Error(
            `both active dispatches have not received TERM: ${JSON.stringify(values)}`,
          );
        }
        return values;
      }, LIFECYCLE_RETRY_OPTIONS);

      // Listener shutdown is phase zero now. A request racing that boundary
      // may either reach the already-closed admission fence (503) or find the
      // loopback socket closed; both are correct, but it must never launch a
      // harness after the shutdown snapshot.
      const lateOwnership = `dispatch-after-shutdown-${randomUUID()}`;
      const late = await fetch(url(a, "/_sandbox/dispatch"), {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({
          runId: freshRunId("after-shutdown"),
          harnessId: "claude-code",
          input: buildDispatchInput({
            threadId: "dispatch-after-shutdown-thread",
            prompt: `SCENARIO:simple OWNERSHIP:${lateOwnership}`,
          }),
        }),
      }).catch(() => null);
      if (late) {
        expect(late.status).toBe(503);
        expect(await late.json()).toMatchObject({
          error: "application is shutting down",
        });
      }

      await retry(async () => {
        if (a.proc.exitCode === null && a.proc.signalCode === null) {
          throw new Error("local-api has not completed graceful shutdown");
        }
        const alive = children.filter((child) => processIsAlive(child.pid));
        if (alive.length > 0) {
          throw new Error(
            `legacy dispatch children survived shutdown: ${JSON.stringify(alive)}`,
          );
        }
      }, LIFECYCLE_RETRY_OPTIONS);

      const signalTimes = shutdownSignals.map(({ at }) => {
        if (typeof at !== "number")
          throw new Error("signal log omitted timestamp");
        return at;
      });
      expect(
        Math.max(...signalTimes) - Math.min(...signalTimes),
        "legacy dispatch cancellation was serialized across TERM grace periods",
      ).toBeLessThan(500);
      expect(
        readJsonLines(invocationLog).some(
          (entry) => entry.ownership === lateOwnership,
        ),
        "a post-shutdown dispatch reached the harness",
      ).toBe(false);
      await Promise.all(responses.map((response) => response.text()));
    },
    30_000,
  );
});
