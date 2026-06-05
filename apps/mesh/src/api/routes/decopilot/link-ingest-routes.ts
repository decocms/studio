/**
 * Link ingest — the RETURN path of the pull-inverted local link.
 * The desktop daemon runs the harness and POSTs its UIMessageChunk SSE stream
 * here; this endpoint commits completed parts to `thread_message_parts` (via
 * PartEmitter) and republishes chunks to the JetStream live edge. The fence
 * token rejects a stale producer's writes with 409.
 */
import { Hono } from "hono";
import { parseDispatchSSEStream } from "@/harnesses/parse-dispatch-sse";
import { fenceMatches } from "@/storage/run-fence";
import { PartEmitter } from "./part-emitter";
import { consumePartStream } from "./consume-part-stream";
import type { StreamBuffer } from "./stream-buffer";
import type { Env } from "../../hono-env";

export interface LinkIngestDeps {
  streamBuffer: StreamBuffer;
}

async function drain(stream: ReadableStream): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

export function createLinkIngestRoutes(deps: LinkIngestDeps) {
  const app = new Hono<Env>();

  app.post("/links/runs/:runId/stream", async (c) => {
    const ctx = c.get("meshContext");
    const runId = c.req.param("runId");
    const presented = c.req.header("x-fence-token") ?? null;

    const current = await ctx.storage.threads.getRunFence(runId);
    if (!fenceMatches(current, presented)) {
      return c.json({ error: "fenced" }, 409);
    }

    const body = c.req.raw.body;
    if (!body) return c.json({ error: "missing body" }, 400);

    const orgId = ctx.organization!.id;

    const partEmitter = new PartEmitter({
      storage: ctx.storage.threads.messageParts(),
      orgId,
      threadId: runId, // thread id == run id today
      runId,
    });

    const chunks = parseDispatchSSEStream(body);
    const { uiStream, whenComplete } = consumePartStream(chunks, partEmitter);

    // Tee: one branch feeds the live edge (pump no-ops if NATS is down), the
    // other is drained so the stream is consumed regardless. `whenComplete` is
    // the authoritative "all parts committed" signal.
    const [toPump, toConsume] = uiStream.tee();
    deps.streamBuffer.pump(toPump, runId, c.req.raw.signal);
    await drain(toConsume);
    await whenComplete;

    return c.json({ ok: true });
  });

  return app;
}
