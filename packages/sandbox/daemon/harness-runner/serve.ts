/**
 * Harness-runner server — the runner side of harness-runner/protocol.ts.
 *
 * A slim loopback HTTP service that owns ONLY harness execution: it registers
 * the CLI harness factories and streams a run's UIMessageChunks back as
 * NDJSON `DispatchSSEEvent` lines. Every transport invariant (auth against
 * clients, tombstones, SSRF allowlist, run registry, SSE framing) stays in
 * the daemon — the runner trusts its single caller, gated by the per-spawn
 * bearer token and the 127.0.0.1 bind.
 */
import { claudeCodeHarnessFactory } from "@decocms/harness/claude-code/index";
import { codexHarnessFactory } from "@decocms/harness/codex/index";
import {
  getHarnessFactory,
  registerHarnessFactory,
} from "@decocms/harness/registry";
import type {
  HarnessContext,
  HarnessId,
  HarnessStreamInput,
} from "@decocms/harness/types";
import { metrics, trace } from "@opentelemetry/api";
import type { DispatchSSEEvent } from "../../dispatch/index";
import type { LinkErrorCode } from "../../dispatch/error-codes";
import {
  HARNESS_RUNNER_READY_PREFIX,
  HARNESS_RUNNER_TOKEN_ENV,
} from "./protocol";

export function serveHarnessRunner(): void {
  registerHarnessFactory(claudeCodeHarnessFactory);
  registerHarnessFactory(codexHarnessFactory);

  const token = process.env[HARNESS_RUNNER_TOKEN_ENV] ?? "";
  const tracer = trace.getTracer("harness-runner");
  const meter = metrics.getMeter("harness-runner");
  const encoder = new TextEncoder();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method !== "POST" || pathname !== "/run") {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      // Empty expected token must never match (mirrors daemon auth.ts).
      const auth = req.headers.get("authorization") ?? "";
      if (!token || auth !== `Bearer ${token}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      let body: { harnessId?: unknown; input?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      const harnessId = body.harnessId;
      if (typeof harnessId !== "string") {
        return Response.json({ error: "missing_harness_id" }, { status: 400 });
      }
      const factory = getHarnessFactory(harnessId as HarnessId);
      if (!factory) {
        return Response.json({ error: "unknown_harness" }, { status: 400 });
      }

      // The daemon validated + rebased the input; the wire strips `signal`
      // (not serializable), so reconstruct cancellation from the request:
      // the daemon cancels a run by aborting its /run fetch.
      const input = body.input as HarnessStreamInput;
      const ctrl = new AbortController();
      req.signal.addEventListener("abort", () => ctrl.abort());
      input.signal = ctrl.signal;

      const ctx: HarnessContext = {
        tracer,
        meter,
        metadata: {
          threadId: input.threadId,
          orgId: input.organizationId,
          userId: input.user?.id,
        },
      };
      const harness = factory.create(ctx);

      const state = { closed: false };
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const write = (event: DispatchSSEEvent): void => {
            if (state.closed || ctrl.signal.aborted) return;
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
            } catch {
              state.closed = true;
            }
          };
          let chunkCount = 0;
          try {
            for await (const chunk of harness.stream(input)) {
              if (ctrl.signal.aborted || state.closed) break;
              chunkCount++;
              write({ type: "ui-message-chunk", chunk });
            }
            console.log(
              `[harness-runner] done harness=${harnessId} threadId=${input.threadId} chunks=${chunkCount} aborted=${ctrl.signal.aborted}`,
            );
          } catch (err) {
            console.error(
              `[harness-runner] harness crashed harness=${harnessId} threadId=${input.threadId} chunks=${chunkCount}:`,
              err,
            );
            const code: LinkErrorCode = "harness_crashed";
            write({
              type: "error",
              code,
              message: err instanceof Error ? err.message : String(err),
            });
          } finally {
            write({ type: "done" });
            if (!state.closed) {
              try {
                controller.close();
              } catch {
                // Already closed by a consumer cancel — nothing to do.
              }
            }
          }
        },
        cancel() {
          state.closed = true;
          ctrl.abort();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });
    },
  });

  // Die with the daemon even on SIGKILL orphaning: the daemon holds our
  // stdin pipe open and never writes — it closing (for any reason) means
  // the parent is gone.
  const exitOnParentGone = () => process.exit(0);
  process.stdin.resume();
  process.stdin.on("end", exitOnParentGone);
  process.stdin.on("close", exitOnParentGone);
  process.stdin.on("error", exitOnParentGone);

  console.log(
    `${HARNESS_RUNNER_READY_PREFIX}${JSON.stringify({ port: server.port })}`,
  );
}
