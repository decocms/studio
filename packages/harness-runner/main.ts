#!/usr/bin/env bun
/**
 * The harness-runner: the TS half of the Go daemon's `/dispatch` path.
 *
 * The daemon spawns this process once per pod and drives it over loopback HTTP.
 * The wire is defined by `packages/sandbox/daemon-go/internal/dispatch/runner.go`
 * — keep the two in step:
 *
 *   spawn   argv from HARNESS_RUNNER_CMD, env HARNESS_RUNNER_MODE=1 and a
 *           per-spawn HARNESS_RUNNER_TOKEN
 *   ready   print `HARNESS_RUNNER_READY {"port":N}` on stdout
 *   run     POST /run with that bearer, body {harnessId, input, env}; answer
 *           200 application/x-ndjson, one DispatchSSEEvent per line, always
 *           terminated by {"type":"done"}. `env` is the run's tenant
 *           environment — the model credential among it — which this process
 *           does not inherit: it is spawned once and reused across runs, so a
 *           credential must not outlive the run it came with.
 *   cancel  the daemon aborts the request; tear the harness down with it
 *
 * stdin is a parent-death signal: the daemon holds it open for this process's
 * whole life, so EOF means the daemon is gone and this process must not linger
 * holding a port.
 */

import type { DispatchSSEEvent } from "@decocms/sandbox/dispatch/schemas";
import { runClaudeCode } from "./claude-code";

const READY_PREFIX = "HARNESS_RUNNER_READY ";

const token = process.env.HARNESS_RUNNER_TOKEN;
if (process.env.HARNESS_RUNNER_MODE !== "1" || !token) {
  console.error(
    "harness-runner: refusing to start without HARNESS_RUNNER_MODE=1 and HARNESS_RUNNER_TOKEN",
  );
  process.exit(2);
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

function bearerOk(req: Request): boolean {
  const header = req.headers.get("authorization");
  return header === `Bearer ${token}`;
}

/**
 * Stream one run as NDJSON. `done` is written in a finally so it survives a
 * harness throw — the daemon reads a stream that ends without `done` as a
 * crash, and that must mean "actually crashed", not "we forgot".
 */
function ndjsonResponse(
  events: AsyncIterable<DispatchSSEEvent>,
  signal: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (event: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      // Flush the response headers before the harness produces anything. Bun
      // writes them on the first enqueue, and a claude-code turn emits nothing
      // until the SDK reports `result` — so without this the daemon's
      // `ResponseHeaderTimeout` (30s) fires on a run that is merely thinking.
      // A blank line, not an event: the daemon's NDJSON reader skips empty
      // lines (dispatch.go), so this needs no protocol change.
      controller.enqueue(encoder.encode("\n"));
      try {
        for await (const event of events) {
          if (signal.aborted) break;
          write(event);
        }
      } catch (err) {
        // A throw that escaped the harness itself. Report it rather than
        // letting the daemon infer a crash from a truncated stream.
        if (!signal.aborted) {
          write({
            type: "error",
            code: "harness_crashed",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        if (!signal.aborted) write({ type: "done" });
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
    },
  });
}

async function* unknownHarness(
  harnessId: unknown,
): AsyncGenerator<DispatchSSEEvent> {
  yield {
    type: "error",
    code: "unknown_harness",
    message: `harness-runner does not implement ${JSON.stringify(harnessId)}`,
  };
}

async function* badInput(message: string): AsyncGenerator<DispatchSSEEvent> {
  yield { type: "error", code: "bad_input", message };
}

/**
 * The wire's `env` narrowed to string values. Absent/malformed → undefined, so
 * the harness runs on this process's environment alone.
 *
 * ⚠️ SECURITY: the result holds a model credential. Never log it.
 */
function stringEnv(env: unknown): Record<string, string> | undefined {
  if (typeof env !== "object" || env === null) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const server = Bun.serve({
  // Ephemeral port: the daemon learns it from the ready line, and binding
  // loopback-only keeps the runner unreachable from outside the pod.
  port: 0,
  hostname: "127.0.0.1",
  // No idle timeout. A claude-code turn is deliberately buffered until the SDK
  // reports `result`, so this stream is legitimately silent for as long as the
  // model thinks — minutes, on a real task. Bun's 10s default tore the
  // connection down mid-turn, which the daemon correctly read as a crashed
  // runner ("unexpected EOF"). Bun caps any finite value at 255s, so every
  // finite value is also wrong here. Cancellation comes from the daemon
  // aborting the request, and a dead daemon is caught by the stdin EOF below.
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/run") {
      return new Response("not found", { status: 404 });
    }
    if (!bearerOk(req)) return unauthorized();

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return ndjsonResponse(badInput("request body is not JSON"), req.signal);
    }
    if (typeof body !== "object" || body === null) {
      return ndjsonResponse(
        badInput("request body is not an object"),
        req.signal,
      );
    }
    const { harnessId, input, env } = body as {
      harnessId?: unknown;
      input?: unknown;
      env?: unknown;
    };
    if (harnessId !== "claude-code") {
      return ndjsonResponse(unknownHarness(harnessId), req.signal);
    }
    if (typeof input !== "object" || input === null) {
      return ndjsonResponse(badInput("input is missing"), req.signal);
    }
    // The daemon validated the envelope (internal/dispatch/validate.go) before
    // forwarding, so this trusts the shape and reads the fields it needs. `env`
    // is the exception: it lands straight in a subprocess environment, so a
    // non-string value gets dropped rather than coerced to "undefined".
    return ndjsonResponse(
      runClaudeCode(
        input as Parameters<typeof runClaudeCode>[0],
        req.signal,
        stringEnv(env),
      ),
      req.signal,
    );
  },
});

console.log(`${READY_PREFIX}${JSON.stringify({ port: server.port })}`);

// Parent-death signal: EOF on stdin means the daemon is gone. The daemon never
// writes to stdin, so draining it is only how we notice that EOF.
for await (const _chunk of Bun.stdin.stream()) {
  // intentionally empty
}
server.stop(true);
process.exit(0);
