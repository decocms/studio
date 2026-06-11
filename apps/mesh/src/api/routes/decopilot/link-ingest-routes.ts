/**
 * Link ingest — the RETURN path of the pull-inverted local link (protocol v2).
 *
 * The desktop daemon relays its sandbox's raw harness output as seq-numbered
 * NDJSON `RelayLine`s ({seq, event: DispatchSSEEvent}) to
 *   POST /api/:org/links/runs/:runId/chunks
 * (see `links/protocol/relay.ts` + `link-daemon/chunk-relay.ts`). The first
 * POST opens an in-memory `RelaySession` pinned to this pod; the session feeds
 * ONE `consumeHarnessStream` invocation for the whole run, so the harness
 * kernel is the single consumer for pull runs exactly as it is for hosted
 * runs — titles, usage (PostHog), parts/messages, error sanitization, run
 * status, and the JetStream live edge all flow through the same code path.
 *
 * Reconnect/backfill: the daemon resends the FULL prefix from seq 1 on every
 * attempt (`x-relay-from: 1` always, today); the session dedupes by seq, so
 * replays are safe. The cluster acks once per POST after the body ends with
 * `{ok, lastSeq}`; a terminal POST (after a `done`/`error` line) is acked only
 * after the kernel committed all durable effects.
 *
 * Registry loss (pod restart/crash) is RECOVERABLE, not terminal: because the
 * shipped daemon always posts `x-relay-from: 1`, a pod with no session for the
 * runId opens a FRESH session and re-consumes the full prefix from seq 1 —
 * parts are id-deduped and the completed transition is guarded, so the
 * redelivery is idempotent. The `410 relay_session_lost` branch (resumed relay
 * with `x-relay-from > 1` and no session) is therefore currently UNREACHABLE
 * from the shipped daemon; it is kept for a future mid-stream resume. A
 * reconnect landing on ANOTHER pod opens a concurrent fresh session there; the
 * same dedupe/guard make that safe (live-edge chunks may duplicate, the
 * completed event may double-fire — acceptable, documented). An abandoned
 * session (daemon death without an error line) is reaped by the relay
 * registry's per-session idle timer, which fails the run.
 *
 * Fence epochs: a parked session is keyed by runId (== threadId today). The
 * NEXT run on the same thread mints a fresh fence and relays from seq 1, so
 * attaching by runId alone would splice fresh lines into the stale kernel. The
 * route attaches an existing session only when its fence matches the presented
 * (DB-validated) fence; a mismatch evicts the stale session (`relay_superseded`
 * — no durable status write, since the same runId row is re-driven by the
 * fresh session) and opens a new one.
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
import type { Thread, ThreadMessage } from "@/storage/types";
import {
  classifyStreamError,
  sanitizeStreamError,
  stringifyError,
} from "@decocms/harness/decopilot/stream-error";
import {
  createDecopilotFinishEvent,
  createDecopilotThreadStatusEvent,
} from "@decocms/mesh-sdk";
import { consumeHarnessStream } from "./consume-harness-stream";
import { buildOnTitleUpdated } from "./on-title-updated";
import { PartEmitter } from "./part-emitter";
import { ProgressBumpThrottle } from "./progress-bump";
import { createRelaySessionRegistry } from "./relay-session";
import type { StreamBuffer } from "./stream-buffer";
import type { ChatMessage } from "./types";
import type { Env } from "../../hono-env";
import type { SSEEvent } from "@/event-bus";
import { meter } from "@/observability";

/**
 * Eviction code stamped on the iterable failure when a stale parked session is
 * superseded by a fresh run on the same runId (see relay-session.ts). The
 * relayed-run consumer treats this as a NON-failure: it tears down without
 * writing a durable `failed` status, because the same run row is about to be
 * re-driven by the fresh session.
 */
const RELAY_SUPERSEDED_CODE = "relay_superseded";

// Mirrors dispatch-run's save-errors counter (same name/attrs) so v1 save
// failures on the pull return path are visible in OTEL alongside hosted runs.
const saveErrorsCounter = meter.createCounter("decopilot.save.errors", {
  description:
    "Number of message-save failures during decopilot run dispatch (v1 and v2 paths)",
  unit: "{errors}",
});

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

export interface LinkIngestDeps {
  streamBuffer: StreamBuffer;
  sseHub?: { emit(orgId: string, event: SSEEvent): void };
  /**
   * Publish-then-consume ingest (spec §5.3/§5.4). OFF by default (legacy: the
   * processed `uiStream` is pumped to DECOPILOT_STREAMS). When ON, the relay's
   * RAW chunks are published to the same subject as they arrive (the durable
   * commit + the UI-tail's source) and the processed `uiStream` is only drained
   * for persistence/title/usage — never pumped. Persistence, title, usage,
   * PostHog and terminal status are byte-identical between the two paths (the
   * same `consumeHarnessStream` wiring runs verbatim); only the NATS source
   * flips processed→raw. Gated so the inversion can be validated by multi-pod
   * e2e (real NATS+PG) before the legacy pump path is retired.
   */
  publishThenConsume?: boolean;
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

/**
 * Resume floor for a relay reconnect (replaces the old `x-relay-from > 1` 410
 * stub). The fence-scoped cursor (spec §5.3/N6): resume from `lastSeq + 1` when
 * the presented fence matches the parked session's epoch; a new epoch (or no
 * parked session) resends the full prefix from seq 1. Drives the WS uplink's
 * `accept` cursor; the NDJSON path stays full-prefix because its parked session
 * is gone after pod loss.
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

interface ConsumeRelayedRunArgs {
  ctx: StudioContext;
  deps: LinkIngestDeps;
  runId: string;
  thread: Thread;
  chunks: AsyncIterable<UIMessageChunk>;
}

/** True when an error is the supersede eviction signal (relay-session.ts) —
 *  NOT a run failure, so it must not write a durable failed status. */
function isSupersededError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === RELAY_SUPERSEDED_CODE
  );
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
async function consumeRelayedRun(args: ConsumeRelayedRunArgs): Promise<void> {
  const { ctx, deps, runId, thread, chunks } = args;
  const orgId = ctx.organization!.id;
  const distinctId = ctx.auth.user!.id;
  const streamStartAt = Date.now();

  // Set when this session was superseded by a fresh run on the same runId. The
  // fresh session owns the run row AND its `${runId}:${messageId}:${seq}` part-id namespace
  // now, so this stale consume must perform ZERO persistence and ZERO terminal
  // status writes — otherwise a stale error/partial part would collide (ON
  // CONFLICT id DO NOTHING) with the fresh run's first part and silently drop
  // it. We intercept the supersede signal at the chunk boundary (below) and
  // end the stream cleanly so the kernel never runs its error/emitError path;
  // every persistence callback + the finish hook + the terminal completion are
  // additionally guarded on this flag.
  let superseded = false;

  // Wrap the relay chunk iterable so a `relay_superseded` eviction ends the
  // stream cleanly (no kernel error, no emitError) instead of throwing.
  const guardedChunks = (async function* () {
    try {
      yield* chunks;
    } catch (error) {
      if (isSupersededError(error)) {
        superseded = true;
        return; // clean end — kernel runs onFinish, not onError
      }
      throw error;
    }
  })();

  const isV2 = thread.message_storage_version === 2;
  const partEmitter = isV2
    ? new PartEmitter({
        storage: ctx.storage.threads.messageParts(),
        orgId,
        threadId: runId, // thread id == run id today
        runId,
      })
    : null;

  // v1 whole-message save — same shape as dispatch-run's saveMessagesToThread
  // closure (dedupe by id, drop empty messages, stamp thread_id + timestamps),
  // built on the same storage helper (`threads.saveMessages` is what
  // Memory.save wraps).
  const saveMessagesToThread = async (
    ...messages: (ChatMessage | undefined)[]
  ) => {
    const now = Date.now();
    const messagesToSave = [
      ...new Map(messages.filter(Boolean).map((m) => [m!.id, m!])).values(),
    ]
      .filter((m) => m.parts && m.parts.length > 0)
      .map((message, i) => ({
        ...message,
        thread_id: runId,
        created_at: new Date(now + i).toISOString(),
        updated_at: new Date(now + i).toISOString(),
      }));
    if (messagesToSave.length === 0) return;
    await ctx.storage.threads
      .saveMessages(messagesToSave as ThreadMessage[])
      .catch((error) => {
        // Same OTEL signal dispatch-run increments at its v1 save .catch sites
        // (same counter name + org.id attr) so pull save failures are visible
        // without log scraping.
        saveErrorsCounter.add(1, { "org.id": orgId });
        console.error("[link-ingest] Error saving messages", error);
      });
  };

  // Captured usage for the unconditional completed event (Fix 4): the kernel's
  // onUsage fires only when the final message carries usage metadata, so a
  // truncated/zero-token run would otherwise emit no completion event. Capture
  // here, fire in onFinish unconditionally (captured totals or zeros).
  let capturedUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  // Set when the kernel's onError fired, so onFinish (which still runs after a
  // source error) doesn't double-emit a `completed` event for a failed run.
  let runErrored = false;

  // Publish-then-consume (spec §5.3/§5.4), gated on `deps.publishThenConsume`.
  // When ON, each RAW chunk is published to DECOPILOT_STREAMS as a side effect
  // of the kernel pulling it — so the UI tail reads raw chunks and the durable
  // commit happens before persistence. The kernel still consumes the SAME
  // chunks, so persistence/title/usage are unchanged. When OFF, the kernel
  // reads `guardedChunks` directly and the processed uiStream is pumped (legacy).
  const sourceChunks = deps.publishThenConsume
    ? (async function* () {
        for await (const chunk of guardedChunks) {
          await deps.streamBuffer.publishRawChunk(runId, chunk);
          yield chunk;
        }
      })()
    : guardedChunks;

  const { uiStream, whenComplete } = consumeHarnessStream({
    chunks: sourceChunks,
    originalMessages: [],
    title: {
      currentThreadTitle: thread.title,
      threadId: runId,
      persistTitle: async (threadId, title) => {
        await ctx.storage.threads.update(threadId, { title });
      },
      onTitleUpdated: deps.sseHub
        ? buildOnTitleUpdated({
            ctx,
            sseHub: deps.sseHub,
            threadId: runId,
            organizationId: orgId,
          })
        : undefined,
    },
    persistence: {
      // Every persistence callback is a no-op once superseded: the fresh
      // session owns this runId's part-id namespace, so a stale write would
      // collide and drop the fresh run's parts.
      emitStepParts: async (responseMessage) => {
        if (superseded || !partEmitter) return;
        await partEmitter.emitStepParts(responseMessage);
      },
      emitFinal: async (responseMessage) => {
        if (superseded) return;
        if (partEmitter) {
          await partEmitter.emitFinal(responseMessage);
          return;
        }
        await saveMessagesToThread(responseMessage as ChatMessage);
      },
      emitError: async (messageId, errorText) => {
        if (superseded) return;
        const sanitized = sanitizeStreamError(errorText);
        if (partEmitter) {
          await partEmitter.emitError(messageId, sanitized);
          return;
        }
        await saveMessagesToThread({
          id: messageId,
          role: "assistant",
          parts: [{ type: "text", text: `Error: ${sanitized}` }],
          metadata: { errorCategory: classifyStreamError(errorText) },
        } as ChatMessage);
      },
    },
    // Wire error chunks synthesized from a failed relay source carry
    // sanitized text, same as hosted runs.
    sanitizeErrorText: sanitizeStreamError,
    hooks: {
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
      onFinish: () => {
        // A failed run already emitted `chat_message_failed` in onError — don't
        // also emit `completed` for it. A superseded run emits nothing — the
        // fresh session owns completion.
        if (runErrored || superseded) return;
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
        // A supersede eviction never reaches here — `guardedChunks` converts it
        // to a clean stream end (onFinish, not onError). Any error in onError is
        // therefore a genuine run failure.
        runErrored = true;
        console.error("[link-ingest] relayed stream error:", error);
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
            error_message:
              error instanceof Error ? error.message : stringifyError(error),
          },
        });
        // Durable terminal failure — same column shape as the reactor's
        // handleTerminalStatus. The kernel awaits this (via its pending-ops
        // barrier) before whenComplete resolves, so the completed-path
        // `completeRunIfNotCompleted` below can never resurrect a failed run.
        await ctx.storage.threads.update(runId, {
          status: "failed",
          run_owner_pod: null,
          run_config: null,
          run_started_at: null,
        });
        // Failure SSE parity with the run-reactor's RUN_FAILED handling:
        // emit the same failed thread-status + finish events the hosted path
        // emits, so tabs not tailing /stream see the failure in real time.
        if (deps.sseHub) {
          const failedThread = await ctx.storage.threads
            .get(runId)
            .catch(() => null);
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
        }
      },
    },
  });

  // `pump` is the SOLE consumer of `uiStream` (never tee it). A non-null tail
  // means JetStream is live (pump consumes uiStream + the tail mirrors it for
  // /stream); a null tail means no JetStream, so drain uiStream directly so
  // parts still commit. Either way `whenComplete` is the authoritative "all
  // durable effects committed" signal. The signal is session-scoped (a relay
  // session spans many HTTP requests, so no request signal applies).
  if (deps.publishThenConsume) {
    // Raw chunks were already published to NATS as a side effect of the kernel
    // pulling `sourceChunks`; the UI tail reads those raw chunks. Drain the
    // processed uiStream so persistence/title still run — but do NOT pump it
    // (raw is the NATS source now). `whenComplete` remains authoritative.
    await drain(uiStream).catch(() => {});
  } else {
    const sessionAbort = new AbortController();
    const tail = await deps.streamBuffer.createTailStream(
      runId,
      sessionAbort.signal,
      { deliverPolicy: "new", closeOnDone: true },
    );
    if (tail) {
      deps.streamBuffer.pump(uiStream, runId, sessionAbort.signal, orgId);
      await drain(tail).catch(() => {});
    } else {
      await drain(uiStream).catch(() => {});
    }
  }
  await whenComplete;

  // Superseded: a fresh session now owns this runId's row. Bail out before any
  // terminal write — the live session drives completion/failure, and the
  // JetStream subject + progress throttle belong to it now too.
  if (superseded) return;

  // Transition the run terminal so the gate's polling loop unblocks (spec
  // §L6). Fungible-pod-safe: a direct durable write (no RunRegistry, which is
  // pod-local). Guarded — only an in_progress run completes, so the failed
  // status written by onError above (or a reaper kill) is never overwritten.
  const completedThread =
    await ctx.storage.threads.completeRunIfNotCompleted(runId);
  deps.streamBuffer.purge(runId);
  if (completedThread && deps.sseHub) {
    deps.sseHub.emit(
      orgId,
      createDecopilotThreadStatusEvent(runId, "completed", {
        virtualMcpId: completedThread.virtual_mcp_id ?? undefined,
        createdBy: completedThread.created_by,
        triggerId: completedThread.trigger_id,
        title: completedThread.title,
        branch: completedThread.branch ?? null,
        createdAt: completedThread.created_at,
        updatedAt: completedThread.updated_at,
      }),
    );
    deps.sseHub.emit(orgId, createDecopilotFinishEvent(runId, "completed"));
  }
}

export function createLinkIngestRoutes(deps: LinkIngestDeps) {
  const app = new Hono<Env>();
  const relayRegistry = createRelaySessionRegistry();
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
    // canonical epoch the relay session is keyed by.
    return { ctx, runId, thread, presentedFence: presented };
  }

  app.post("/links/runs/:runId/chunks", async (c) => {
    const access = await validateRunAccess(c);
    if (access instanceof Response) return access;
    const { ctx, runId, thread, presentedFence } = access;

    const body = c.req.raw.body;
    if (!body) return c.json({ error: "missing body" }, 400);

    // Fence-epoch session resolution. A parked session keyed by runId may
    // belong to a STALE run (runId == threadId; a dead daemon left it parked).
    // Attach only when the existing session's fence matches the presented (and
    // DB-validated) fence; otherwise evict the stale one — failing its iterable
    // so its consume() tears down without a durable status write
    // (relay_superseded) — and open a fresh session for this epoch.
    const current = relayRegistry.get(runId);
    let session;
    if (current && current.fenceToken === presentedFence) {
      session = current;
    } else {
      if (current) {
        relayRegistry.evict(runId, "relay_superseded");
      }
      // No parked session (pod loss) OR superseded epoch: open a fresh session.
      // A resumed relay (`x-relay-from > 1`) no longer 410s — a full-prefix
      // resend is idempotent (§10, the cluster dedupes by seq), so the daemon
      // resends from seq 1 and we splice cleanly. The WS path uses the
      // fence-scoped `resumeFloorForRelay` cursor instead of full-prefix.
      session = relayRegistry.open(runId, presentedFence, {
        consume: (chunks) =>
          consumeRelayedRun({ ctx, deps, runId, thread, chunks }),
      });
    }

    try {
      for await (const value of ndjsonLines(body)) {
        const line = relayLineSchema.safeParse(value);
        if (!line.success) {
          return c.json({ error: "bad line" }, 400);
        }
        session.push(line.data);
        if (progressThrottle.shouldBump(runId)) {
          ctx.storage.threads.bumpProgress(runId).catch(() => {});
        }
      }
    } catch (error) {
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

    if (session.ended) {
      // Terminal POST: ack only after the kernel committed all durable
      // effects — the daemon treats a post-terminal ack as run completion.
      // A consume failure is still acked (ok + lastSeq): the relay delivered
      // every line; retrying the upload cannot fix a cluster-side failure,
      // and the run was already transitioned to failed by the error hooks.
      await session.whenComplete.catch(() => {});
      progressThrottle.clear(runId);
    }
    return c.json({ ok: true, lastSeq: session.lastSeq });
  });

  return app;
}
