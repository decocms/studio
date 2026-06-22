/**
 * Link ingest — the RETURN path of the pull-inverted local link (protocol v2).
 *
 * The desktop daemon relays its sandbox's raw harness output as seq-numbered
 * NDJSON `RelayLine`s ({seq, event: DispatchSSEEvent}) to
 *   POST /api/:org/links/runs/:runId/chunks
 * (see `links/protocol/relay.ts` + `link-daemon/chunk-relay.ts`). Each POST is
 * self-contained and stateless on the cluster: raw chunks are published to
 * JetStream under their daemon-assigned seq, while a request-local live
 * consumer drives usage/PostHog/SSE hooks for the chunks in this upload.
 *
 * Reconnect/backfill: the daemon resends the FULL prefix from seq 1 on every
 * attempt (`x-relay-from: 1` always, today). The durable ack floor stored on the
 * thread and JetStream `Nats-Msg-Id` dedup make replays safe across any pod. A
 * successful POST must contain a terminal `done` or `error` line; the cluster no
 * longer parks pod-local relay sessions waiting for a later request.
 *
 * AUTHZ: requires an authenticated principal; the run's thread must exist in
 * the path org (404 otherwise — closes the old cross-org fence-lookup TODO);
 * a durable cancel rejects with 409 even on a valid fence; the presented
 * x-fence-token must match the run fence minted by `prepareRun` (409).
 */
import { Hono, type Context } from "hono";
import type { UIMessageChunk } from "ai";
import { posthog } from "@/posthog";
import type { StudioContext } from "@/core/studio-context";
import { relayLineSchema } from "@/links/protocol/relay";
import { fenceMatches } from "@/storage/run-fence";
import { isCancelRequested } from "@/storage/cancel-flag";
import type { Thread } from "@/storage/types";
import {
  classifyStreamError,
  stringifyError,
} from "@decocms/harness/decopilot/stream-error";
import {
  createDecopilotFinishEvent,
  createDecopilotThreadStatusEvent,
} from "@decocms/mesh-sdk";
import {
  consumeHarnessStream,
  type HarnessStreamConsumerHooks,
  type HarnessStreamPersistence,
} from "./consume-harness-stream";
import { PartEmitter } from "./part-emitter";
import { makeAckedSeqThrottle } from "./acked-seq-throttle";
import { buildOnTitleUpdated } from "./on-title-updated";
import { ProgressBumpThrottle } from "./progress-bump";
import { buildChunkMsgId } from "./projector-stream-messages";
import type { StreamBuffer } from "./stream-buffer";
import type { Env } from "../../hono-env";
import type { SSEEvent } from "@/event-bus";

/**
 * Hard per-line cap for the relay NDJSON body. A single relay line carries one
 * DispatchSSEEvent; a multi-megabyte line is a protocol violation (or a hostile
 * upload) and must fail before `JSON.parse` allocates it. The route maps the
 * tagged error to 400 {error:"line too large"}. Exported so the daemon side and
 * tests can reference the same bound.
 */
export const RELAY_NDJSON_MAX_LINE_BYTES = 1024 * 1024;

/** Thrown by `ndjsonLines` when a single line exceeds the byte cap. */
export class NdjsonLineTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`relay NDJSON line exceeded ${maxBytes} bytes`);
    this.name = "NdjsonLineTooLargeError";
  }
}

function relayProtocolError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "relay_protocol_error" });
}

export interface LinkIngestDeps {
  streamBuffer: StreamBuffer;
  sseHub?: { emit(orgId: string, event: SSEEvent): void };
}

/**
 * Incrementally parse an NDJSON byte stream: split on `\n`, JSON.parse each
 * non-empty line (throws `SyntaxError` on malformed JSON), skip blank lines.
 * Yields lines as soon as their newline arrives, so a streaming relay upload
 * is processed per-line, not per-body.
 *
 * A pending (un-newlined) line is capped at `maxLineBytes`: once the buffer
 * exceeds it without a `\n`, a `NdjsonLineTooLargeError` is thrown so an
 * unbounded line never gets allocated and `JSON.parse`d. The cap is measured
 * on the decoded string length (a conservative proxy for UTF-8 byte length:
 * `string.length <= byteLength`, so the real allocation is always within the
 * intended bound).
 */
export async function* ndjsonLines(
  body: ReadableStream<Uint8Array>,
  maxLineBytes: number = RELAY_NDJSON_MAX_LINE_BYTES,
): AsyncGenerator<unknown, void, undefined> {
  const reader = body.getReader();
  // SINGLE streaming decoder — a multi-byte UTF-8 char can split across reads.
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) yield JSON.parse(line);
        nl = buffer.indexOf("\n");
      }
      // No newline yet but the pending line already blew the cap — stop before
      // it grows further. (Checked after splitting so a fully-consumed buffer
      // never trips it.)
      if (buffer.length > maxLineBytes) {
        throw new NdjsonLineTooLargeError(maxLineBytes);
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail.length > maxLineBytes) {
      throw new NdjsonLineTooLargeError(maxLineBytes);
    }
    if (tail.length > 0) yield JSON.parse(tail);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Resume floor for the WS relay reconnect path. The fence-scoped cursor (spec
 * §5.3/N6) resumes from `lastSeq + 1` when the presented fence matches the
 * current epoch; a new epoch resends the full prefix from seq 1. The NDJSON
 * route ignores `x-relay-from` and relies on durable ack-floor dedup.
 */
export function resumeFloorForRelay(
  session: { lastSeq: number; fenceToken: string | null },
  presentedFence: string | null,
): number {
  if (session.fenceToken === null || session.fenceToken !== presentedFence) {
    return 1;
  }
  return session.lastSeq + 1;
}

interface ConsumeRelayedLiveRunArgs {
  ctx: StudioContext;
  deps: LinkIngestDeps;
  runId: string;
  thread: Thread;
  chunks: AsyncIterable<UIMessageChunk>;
}

const NOOP_PERSISTENCE: HarnessStreamPersistence = {
  emitStepParts: async () => {},
  emitFinal: async () => {},
  emitError: async () => {},
};

function createChunkQueue<T>() {
  const queue: T[] = [];
  let closed = false;
  let failure: unknown;
  let change = Promise.withResolvers<void>();

  const signalChange = () => {
    const prev = change;
    change = Promise.withResolvers<void>();
    prev.resolve();
  };

  return {
    push(value: T) {
      if (closed || failure !== undefined) return;
      queue.push(value);
      signalChange();
    },
    close() {
      if (closed || failure !== undefined) return;
      closed = true;
      signalChange();
    },
    fail(error: unknown) {
      if (closed || failure !== undefined) return;
      failure = error;
      queue.length = 0;
      signalChange();
    },
    async *iterate(): AsyncGenerator<T, void, undefined> {
      while (true) {
        const waiter = change.promise;
        if (failure !== undefined) throw failure;
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (closed) return;
        await waiter;
      }
    },
  };
}

async function drain(stream: ReadableStream): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Cluster-side consume of one relayed run — mirrors dispatch-run's kernel
 * wiring for a chunk source produced on the desktop instead of in-process.
 *
 * Lifecycle parity with hosted runs:
 * - title: interception + persistence via the kernel; SSE title updates via
 *   `buildOnTitleUpdated` when an sseHub is configured.
 * - persistence: same v1/v2 fork as dispatch-run, read off the thread row's
 *   pinned `message_storage_version`. Transport Convergence routes EVERY
 *   user-desktop run to pull (`decidePullDispatch`) regardless of generation,
 *   so both forks are live: v2 threads persist via the PartEmitter; v1 threads
 *   take the whole-message branch, which persists only the final message (no
 *   per-5-step checkpoints — the relay acks per chunk, so mid-run pod death
 *   loses at most the in-flight message, which the daemon's full-prefix resend
 *   replays).
 * - usage → PostHog `chat_message_completed`; failures → console.error +
 *   `chat_message_failed` + a durable `failed` status. Relay events carry
 *   `transport: "pull-relay"` and OMIT model/mode props — the wire harness
 *   input isn't available on the return path.
 * - live edge: kernel output pumps into the JetStream stream buffer (sole
 *   consumer; null tail → direct drain), then the run transitions terminal
 *   and the buffer subject is purged, same as the run-reactor's durable
 *   side-effects (fungible-pod-safe: direct storage write, no RunRegistry).
 *
 * The kernel's `originalMessages` is `[]`: the daemon stream carries complete
 * messages, nothing is being resumed into an existing wire message list.
 */
async function consumeRelayedLiveRun(
  args: ConsumeRelayedLiveRunArgs,
): Promise<void> {
  const { ctx, deps, runId, thread, chunks } = args;
  const orgId = ctx.organization!.id;
  const distinctId = ctx.auth.user!.id;
  const streamStartAt = Date.now();

  // Captured usage for the unconditional completed event (Fix 4): the kernel's
  // onUsage fires only when the final message carries usage metadata, so a
  // truncated/zero-token run would otherwise emit no completion event. Capture
  // here, fire in onFinish unconditionally (captured totals or zeros).
  let capturedUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  // Set when the kernel's onError fired, so onFinish (which still runs after a
  // source error) doesn't double-emit a `completed` event for a failed run.
  let runErrored = false;

  // Emit the failed thread-status + finish SSE events, parity with the
  // run-reactor's RUN_FAILED handling, so tabs not tailing /stream see the
  // failure in real time. Shared by both the legacy inline path and the
  // projector path (live/ephemeral side-effect — NOT a DB write).
  const emitFailureSse = async () => {
    if (!deps.sseHub) return;
    const failedThread = await ctx.storage.threads.get(runId).catch(() => null);
    deps.sseHub.emit(
      orgId,
      createDecopilotThreadStatusEvent(runId, "failed", {
        virtualMcpId: failedThread?.virtual_mcp_id ?? undefined,
        createdBy: failedThread?.created_by,
        triggerId: failedThread?.trigger_id,
        title: failedThread?.title,
        branch: failedThread?.branch ?? null,
        createdAt: failedThread?.created_at,
        updatedAt: failedThread?.updated_at,
      }),
    );
    deps.sseHub.emit(orgId, createDecopilotFinishEvent(runId, "failed"));
  };

  // v2 threads persist assistant parts live through this PartEmitter so the
  // message lands in the DB before the relay POST responds — without it the
  // message was only written by the async projector, so a reload in the gap
  // between stream-end and projection showed it missing. The projector still
  // re-projects from JetStream as an idempotent backstop (deterministic row ids
  // → ON CONFLICT DO NOTHING). v1 threads: legacy read-only → no-op.
  const partEmitter =
    thread.message_storage_version === 2
      ? new PartEmitter({
          storage: ctx.storage.threads.messageParts(),
          orgId,
          threadId: runId,
          runId,
        })
      : null;

  // The live hooks (usage capture, posthog completion/failure, failure SSE) and
  // the durable terminal-status flip. The relay path runs on a fungible pod
  // with no in-memory RunRegistry, so the FINISH reactor never fires here —
  // the status is written directly (idempotent: guarded on `in_progress`). The
  // projector remains a backstop via its own completeRunIfNotCompleted.
  const hooks: HarnessStreamConsumerHooks = {
    // Fires at most once, before onFinish, with the run's usage totals
    // extracted from final message metadata. Capture into a local; the
    // completed event fires UNCONDITIONALLY in onFinish (captured totals or
    // zeros) so a truncated/zero-token run isn't silently dropped. (The
    // model/mode props of dispatch-run's richer completed event need the
    // wire harness input, which the return path doesn't carry.)
    onUsage: (totals) => {
      capturedUsage = {
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        totalTokens: totals.totalTokens,
      };
    },
    onFinish: async (_message, _finishReason, meta) => {
      // A failed run already emitted `chat_message_failed` in onError.
      if (runErrored) return;
      // Flip the durable status to completed as soon as the stream finishes.
      // Skip when a live persistence handoff failed — the message is then
      // incomplete in the DB, so leave the run for the durable projector
      // (which re-projects from JetStream) to finalize authoritatively.
      if (meta?.persistenceOk !== false) {
        await ctx.storage.threads
          .completeRunIfNotCompleted(runId)
          .catch((e) =>
            console.error("[link-ingest] completeRunIfNotCompleted failed", e),
          );
      }
      posthog.capture({
        distinctId,
        event: "chat_message_completed",
        groups: { organization: orgId },
        properties: {
          organization_id: orgId,
          thread_id: runId,
          transport: "pull-relay",
          input_tokens: capturedUsage.inputTokens,
          output_tokens: capturedUsage.outputTokens,
          total_tokens: capturedUsage.totalTokens,
        },
      });
    },
    onError: async (error) => {
      if (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "relay_protocol_error"
      ) {
        return;
      }
      runErrored = true;
      console.error("[link-ingest] relayed stream error:", error);
      const reason =
        error instanceof Error ? error.message : stringifyError(error);
      posthog.capture({
        distinctId,
        event: "chat_message_failed",
        groups: { organization: orgId },
        properties: {
          organization_id: orgId,
          thread_id: runId,
          transport: "pull-relay",
          duration_ms: Date.now() - streamStartAt,
          error_category: classifyStreamError(error),
          error_message: reason,
        },
      });
      // Write the durable failed status before the SSE so a reloading client
      // and the live event agree. Idempotent (guarded on in_progress); the
      // projector's markRunFailed backstops a missed write.
      await ctx.storage.threads
        .markRunFailed(runId, reason, "harness")
        .catch((e) => console.error("[link-ingest] markRunFailed failed", e));
      await emitFailureSse();
    },
  };

  // Title interception + SSE. `persistTitle` is a NO-OP — the durable projector
  // is the sole title writer; only the chunk interception + `onTitleUpdated`
  // SSE fire here.
  const onTitleUpdated = deps.sseHub
    ? buildOnTitleUpdated({
        ctx,
        sseHub: deps.sseHub,
        threadId: runId,
        organizationId: orgId,
      })
    : undefined;

  const { uiStream, whenComplete } = consumeHarnessStream({
    chunks,
    persistence: partEmitter ?? NOOP_PERSISTENCE,
    hooks,
    title: {
      currentThreadTitle: thread.title,
      threadId: runId,
      // Projector owns the title write — neutralize the inline one.
      persistTitle: async () => {},
      onTitleUpdated,
    },
  });

  await drain(uiStream);
  await whenComplete;
}

export function createLinkIngestRoutes(deps: LinkIngestDeps) {
  const app = new Hono<Env>();
  // Per-chunk liveness heartbeat, collapsed to ≤1 `last_progress_at` write
  // per ~3s per run (same throttle dispatch-run's tapProgress uses).
  const progressThrottle = new ProgressBumpThrottle();

  async function validateRunAccess(c: Context<Env>) {
    const ctx = c.get("meshContext");

    // resolveOrgFromPath does NOT require a principal — enforce auth here.
    const userId = ctx.auth?.user?.id;
    if (!userId) return c.json({ error: "unauthorized" }, 401);

    const runId = c.req.param("runId");
    if (!runId) {
      return c.json({ error: "invalid runId" }, 400);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
      return c.json({ error: "invalid runId" }, 400);
    }

    // Org-scoped thread ownership BEFORE any fence/cancel lookups: the
    // org-scoped storage already filters by organization_id, and the explicit
    // check is belt-and-suspenders against a future unscoped adapter. A
    // foreign-org or unknown run is indistinguishable from "not found".
    const thread = await ctx.storage.threads.get(runId);
    if (!thread || thread.organization_id !== ctx.organization!.id) {
      return c.json({ error: "not found" }, 404);
    }

    const presented = c.req.header("x-fence-token") ?? null;

    // Cancel check MUST precede the fence check — a cancelled run must be
    // rejected even when the daemon presents a valid fence token.
    const cancelAt = await ctx.storage.threads.getCancelRequestedAt(runId);
    if (isCancelRequested(cancelAt)) {
      return c.json({ error: "cancelled" }, 409);
    }

    const current = await ctx.storage.threads.getRunFence(runId);
    // No minted fence ⇒ no active pull run for this thread ⇒ nothing should
    // be relaying into it.
    if (current === null) {
      return c.json({ error: "no active run fence" }, 409);
    }
    if (!fenceMatches(current, presented)) {
      return c.json({ error: "fenced" }, 409);
    }

    // `presented` is now validated against the DB-current fence — it's the
    // canonical epoch used in JetStream msg ids and ack-floor writes.
    return { ctx, runId, thread, presentedFence: presented };
  }

  app.post("/links/runs/:runId/chunks", async (c) => {
    const access = await validateRunAccess(c);
    if (access instanceof Response) return access;
    const { ctx, runId, thread, presentedFence } = access;

    const body = c.req.raw.body;
    if (!body) return c.json({ error: "missing body" }, 400);

    const effectiveFenceToken = presentedFence ?? runId;
    let ackSeq = await ctx.storage.threads.getAckedSeq(runId).catch(() => 0);
    const pending = new Set<number>();
    const ackedSeqThrottle = makeAckedSeqThrottle(() => Date.now());
    const liveChunks = createChunkQueue<UIMessageChunk>();
    const liveConsume = consumeRelayedLiveRun({
      ctx,
      deps,
      runId,
      thread,
      chunks: liveChunks.iterate(),
    });

    let lastSeq = 0;
    let finalSeq = 0;
    let sawTerminal = false;

    const recordPublished = (seq: number) => {
      pending.add(seq);
      const previous = ackSeq;
      while (pending.has(ackSeq + 1)) {
        pending.delete(ackSeq + 1);
        ackSeq += 1;
      }
      if (ackSeq > previous && ackedSeqThrottle.shouldWrite(ackSeq)) {
        void ctx.storage.threads
          .bumpAckedSeq(runId, effectiveFenceToken, ackSeq)
          .catch(() => {});
      }
    };

    const publishChunk = async (seq: number, chunk: UIMessageChunk) => {
      finalSeq = Math.max(finalSeq, seq);
      if (seq <= ackSeq || pending.has(seq)) return;
      const ok = await deps.streamBuffer.publishRawChunk(runId, chunk, {
        msgId: buildChunkMsgId({
          runId,
          fenceToken: effectiveFenceToken,
          seq,
        }),
      });
      if (!ok) {
        throw new Error("[link-ingest] stream buffer publish failed");
      }
      recordPublished(seq);
    };

    try {
      for await (const value of ndjsonLines(body)) {
        const line = relayLineSchema.safeParse(value);
        if (!line.success) {
          liveChunks.fail(relayProtocolError("bad relay line"));
          await liveConsume.catch(() => {});
          return c.json({ error: "bad line" }, 400);
        }
        const relayLine = line.data;
        lastSeq = Math.max(lastSeq, relayLine.seq);
        if (!sawTerminal) {
          const event = relayLine.event;
          if (event.type === "ui-message-chunk") {
            const chunk = event.chunk as UIMessageChunk;
            await publishChunk(relayLine.seq, chunk);
            liveChunks.push(chunk);
          } else if (event.type === "error") {
            sawTerminal = true;
            const chunk = {
              type: "error",
              errorText: `${event.code}: ${event.message}`,
            } as UIMessageChunk;
            await publishChunk(relayLine.seq, chunk);
            liveChunks.push(chunk);
            liveChunks.close();
          } else {
            sawTerminal = true;
            liveChunks.close();
          }
        }
        if (progressThrottle.shouldBump(runId)) {
          ctx.storage.threads.bumpProgress(runId).catch(() => {});
        }
      }
    } catch (error) {
      liveChunks.fail(relayProtocolError("bad relay body"));
      await liveConsume.catch(() => {});
      // An over-cap line is a protocol violation (fatal for the daemon) — map
      // it to 400 so the daemon stops resending rather than retrying forever.
      if (error instanceof NdjsonLineTooLargeError) {
        return c.json({ error: "line too large" }, 400);
      }
      // Malformed NDJSON is a protocol violation (fatal for the daemon, like
      // a schema failure). Anything else (e.g. the upload connection died)
      // propagates — the response is undeliverable anyway and the daemon
      // retries with a full-prefix resend.
      if (error instanceof SyntaxError) {
        return c.json({ error: "bad line" }, 400);
      }
      throw error;
    }

    if (!sawTerminal) {
      liveChunks.fail(relayProtocolError("missing terminal relay line"));
      await liveConsume.catch(() => {});
      return c.json({ error: "missing terminal relay line" }, 400);
    }

    await liveConsume.catch(() => {});

    if (finalSeq > 0 && ackSeq < finalSeq) {
      return c.json({ error: "relay seq gap" }, 400);
    }

    if (finalSeq > 0) {
      await ctx.storage.threads
        .bumpAckedSeq(runId, effectiveFenceToken, finalSeq)
        .catch(() => {});
      await deps.streamBuffer.publishDone(runId, effectiveFenceToken, finalSeq);
    }
    progressThrottle.clear(runId);
    return c.json({ ok: true, lastSeq });
  });

  return app;
}
