#!/usr/bin/env bun
/**
 * The harness-runner: the TS half of the Go daemon's `/dispatch` path.
 *
 * One process per run. The daemon execs the argv in `HARNESS_RUNNER_CMD`, writes
 * `{harnessId, input}` to stdin, and reads a stream of `HarnessRunResult` frames
 * back off stdout — one JSON line each, forwarded to Studio as they arrive so a
 * long turn persists as it goes. The wire is
 * `daemon-go/internal/dispatch/runner.go`. stderr is the pod's log.
 * Cancellation is the daemon killing this process group.
 *
 * Exec-per-run is what bounds the model credential: it arrives in this process's
 * environment and dies with it.
 */

import { runClaudeCode, type HarnessRunResult } from "./claude-code";

/** One frame, one line. */
function emit(frame: HarnessRunResult): void {
  console.log(JSON.stringify(frame));
}

/** Always answer with at least one frame, so the daemon never has to infer. */
function fail(code: string, message: string): never {
  emit({ chunks: [], error: { code, message } });
  process.exit(0);
}

const raw = await Bun.stdin.text();
let body: { harnessId?: unknown; input?: unknown };
try {
  body = JSON.parse(raw);
} catch {
  fail("bad_input", "stdin is not JSON");
}
if (body.harnessId !== "claude-code") {
  fail(
    "unknown_harness",
    `harness-runner does not implement ${JSON.stringify(body.harnessId)}`,
  );
}
if (typeof body.input !== "object" || body.input === null) {
  fail("bad_input", "input is missing");
}
// The daemon validated the envelope (internal/dispatch/validate.go) before
// exec'ing this, so the shape is trusted from here.
await runClaudeCode(body.input as Parameters<typeof runClaudeCode>[0], emit);
process.exit(0);
