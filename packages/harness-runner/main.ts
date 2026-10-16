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
 * Stdin is read a line at a time. The first line is the envelope; when the run
 * takes live messages (`input.liveMessages`) the daemon keeps stdin open and
 * writes one `{"liveMessage":…}` line per message, each answered with a
 * `{"liveMessageAck":…}` line (see live-messages.ts).
 *
 * Exec-per-run is what bounds the model credential: it arrives in this process's
 * environment and dies with it.
 */

import { runClaudeCode, type HarnessRunResult } from "./claude-code";
import {
  LiveMessageInbox,
  liveMessageAckLine,
  parseLiveMessageLine,
} from "./live-messages";

/** One frame, one line. */
function emit(frame: HarnessRunResult): void {
  console.log(JSON.stringify(frame));
}

/** Always answer with at least one frame, so the daemon never has to infer. */
function fail(code: string, message: string): never {
  emit({ chunks: [], error: { code, message } });
  process.exit(1);
}

const inbox = new LiveMessageInbox();

/**
 * Stdin's lines other than live messages, which are answered as they arrive —
 * while a turn is running, which is the point — and never reach the caller.
 */
function envelopeLines(): AsyncIterator<string, undefined> {
  const ready: string[] = [];
  let ended = false;
  const waiter: { wake: (() => void) | null } = { wake: null };
  void (async () => {
    for await (const line of console) {
      if (!line.trim()) continue;
      const message = parseLiveMessageLine(parseJson(line));
      if (message) {
        console.log(liveMessageAckLine(message.id, inbox.deliver(message)));
        continue;
      }
      ready.push(line);
      waiter.wake?.();
    }
    ended = true;
    waiter.wake?.();
  })();
  return {
    async next() {
      for (;;) {
        const line = ready.shift();
        if (line !== undefined) return { done: false, value: line };
        if (ended) return { done: true, value: undefined };
        await new Promise<void>((resolve) => (waiter.wake = resolve));
        waiter.wake = null;
      }
    },
  };
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

const lines = envelopeLines();

// Persistent (the daemon's session pool): one envelope per line, the process
// kept between turns. A turn that ends in an error ends the process, so the next
// one starts clean; a clean one ends with `turnEnd`.
if (process.env.HARNESS_RUNNER_PERSISTENT === "1") {
  for (;;) {
    const next = await lines.next();
    if (next.done) break;
    const line = next.value;
    const turnStartedAt = performance.now();
    let turn: { harnessId?: unknown; input?: unknown; beforeRunMs?: unknown };
    try {
      turn = JSON.parse(line);
    } catch {
      fail("bad_input", "a turn line is not JSON");
    }
    if (turn.harnessId !== "claude-code") {
      fail(
        "unknown_harness",
        `harness-runner does not implement ${JSON.stringify(turn.harnessId)}`,
      );
    }
    // The daemon's prep for THIS turn; the spawn env only had the first's.
    process.env.HARNESS_BEFORE_RUN_MS =
      typeof turn.beforeRunMs === "string" ? turn.beforeRunMs : "";
    let failed = false;
    await runClaudeCode(
      turn.input as Parameters<typeof runClaudeCode>[0],
      (frame) => {
        if (frame.error) failed = true;
        emit(frame);
      },
      turnStartedAt,
      inbox,
    );
    if (failed) process.exit(1);
    emit({ chunks: [], turnEnd: true });
  }
  process.exit(0);
}

const first = await lines.next();
let body: { harnessId?: unknown; input?: unknown };
try {
  body = JSON.parse(first.done ? "" : first.value);
} catch {
  fail("bad_input", "stdin is not JSON");
}
if (typeof body.input !== "object" || body.input === null) {
  fail("bad_input", "input is missing");
}
// The daemon validated the envelope (internal/dispatch/validate.go) before
// exec'ing this, so the shape is trusted from here.
switch (body.harnessId) {
  case "claude-code":
    await runClaudeCode(
      body.input as Parameters<typeof runClaudeCode>[0],
      emit,
      undefined,
      inbox,
    );
    process.exit(0);
  default:
    fail(
      "unknown_harness",
      `harness-runner does not implement ${JSON.stringify(body.harnessId)}`,
    );
}
