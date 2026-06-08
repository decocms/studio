/**
 * Link ingest — the RETURN path of the pull-inverted local link.
 * The desktop daemon runs the harness and POSTs its UIMessageChunk SSE stream
 * here; this endpoint commits completed parts to `thread_message_parts` (via
 * PartEmitter) and republishes chunks to the JetStream live edge.
 *
 * SECURITY POSTURE (this phase): run fences are not minted yet, so the endpoint
 * is deliberately INERT — it requires an authenticated principal AND a non-null
 * current fence, rejecting otherwise. It becomes write-capable only once a later
 * phase mints fences in `prepareRun` and the daemon presents the token. NOTE for
 * that phase: also org-scope the fence lookup (`getRunFence` currently resolves
 * any thread id) and enforce thread ownership.
 */
import { Hono } from "hono";
import { parseDispatchSSEStream } from "@/harnesses/parse-dispatch-sse";
import { fenceMatches } from "@/storage/run-fence";
import { isCancelRequested } from "@/storage/cancel-flag";
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

    // resolveOrgFromPath does NOT require a principal — enforce auth here.
    const userId = ctx.auth?.user?.id;
    if (!userId) return c.json({ error: "unauthorized" }, 401);

    const runId = c.req.param("runId");
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
      return c.json({ error: "invalid runId" }, 400);
    }
    const presented = c.req.header("x-fence-token") ?? null;

    // Cancel check MUST precede the fence check — a cancelled run must be
    // rejected even when the daemon presents a valid fence token.
    const cancelAt = await ctx.storage.threads.getCancelRequestedAt(runId);
    if (isCancelRequested(cancelAt)) {
      return c.json({ error: "cancelled" }, 409);
    }

    const current = await ctx.storage.threads.getRunFence(runId);
    // Inert until a fence is minted (a later phase): no fence ⇒ reject, so this
    // endpoint cannot write anything this phase.
    if (current === null) {
      return c.json({ error: "no active run fence" }, 409);
    }
    if (!fenceMatches(current, presented)) {
      return c.json({ error: "fenced" }, 409);
    }

    const body = c.req.raw.body;
    if (!body) return c.json({ error: "missing body" }, 400);

    const partEmitter = new PartEmitter({
      storage: ctx.storage.threads.messageParts(),
      orgId: ctx.organization!.id,
      threadId: runId, // thread id == run id today
      runId,
    });

    const chunks = parseDispatchSSEStream(body);
    const { uiStream, whenComplete } = consumePartStream(chunks, partEmitter);

    // `pump` is the SOLE consumer of `uiStream` (never tee it). Mirror
    // dispatch-run: a non-null tail means JetStream is live (pump consumes
    // uiStream + the tail mirrors it for /stream); a null tail means no
    // JetStream, so drain uiStream directly so parts still commit. Either way
    // `whenComplete` is the authoritative "all parts committed" signal.
    const tail = await deps.streamBuffer.createTailStream(
      runId,
      c.req.raw.signal,
      { deliverPolicy: "new", closeOnDone: true },
    );
    if (tail) {
      deps.streamBuffer.pump(uiStream, runId, c.req.raw.signal);
      await drain(tail).catch(() => {});
    } else {
      await drain(uiStream).catch(() => {});
    }
    await whenComplete;

    // Transition the run to terminal status so the gate's polling loop unblocks
    // (spec §L6). This is fungible-pod-safe: we write directly to durable storage
    // instead of calling runRegistry.execute() which only works on the in-memory
    // RunRegistry of the pod that owns the run (which may be a different pod).
    //
    // Mirrors only the durable side-effects from handleTerminalStatus in
    // run-reactor.ts: update threads.status + clear run_owner_pod/run_config/
    // run_started_at, then purge the live-edge stream buffer subject.
    //
    // Idempotent: setting an already-terminal status is a benign no-op UPDATE.
    // Invariant R3 (parts committed first) is upheld because we only reach here
    // after `await whenComplete`.
    await ctx.storage.threads.update(runId, {
      status: "completed",
      run_owner_pod: null,
      run_config: null,
      run_started_at: null,
    });
    deps.streamBuffer.purge(runId);

    return c.json({ ok: true });
  });

  return app;
}
