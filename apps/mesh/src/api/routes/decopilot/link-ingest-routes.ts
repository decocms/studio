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
 * attempt; the session dedupes by seq, so replays are safe. The cluster acks
 * once per POST after the body ends with `{ok, lastSeq}`; a terminal POST
 * (after a `done`/`error` line) is acked only after the kernel committed all
 * durable effects. Registry loss (pod restart) is terminal: a resumed relay
 * (`x-relay-from` > 1) with no session gets 410 relay_session_lost, the
 * daemon gives up (4xx is non-retriable), and the idle reaper fails the run.
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
} from "@/harnesses/decopilot/stream-error";
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

export interface LinkIngestDeps {
  streamBuffer: StreamBuffer;
  sseHub?: { emit(orgId: string, event: SSEEvent): void };
}

/**
 * Incrementally parse an NDJSON byte stream: split on `\n`, JSON.parse each
 * non-empty line (throws `SyntaxError` on malformed JSON), skip blank lines.
 * Yields lines as soon as their newline arrives, so a streaming relay upload
 * is processed per-line, not per-body.
 */
export async function* ndjsonLines(
  body: ReadableStream<Uint8Array>,
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
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
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

interface ConsumeRelayedRunArgs {
  ctx: StudioContext;
  deps: LinkIngestDeps;
  runId: string;
  thread: Thread;
  chunks: AsyncIterable<UIMessageChunk>;
}

/**
 * Cluster-side consume of one relayed run — mirrors dispatch-run's kernel
 * wiring for a chunk source produced on the desktop instead of in-process.
 *
 * Lifecycle parity with hosted runs:
 * - title: interception + persistence via the kernel; SSE title updates via
 *   `buildOnTitleUpdated` when an sseHub is configured.
 * - persistence: same v1/v2 fork as dispatch-run, read off the thread row's
 *   pinned `message_storage_version`. Pull routing requires v2 today
 *   (`decidePullDispatch`), so the PartEmitter path is the live one; the v1
 *   whole-message branch exists for Task 11 (v1 desktop threads moving to
 *   pull) and persists only the final message (no per-5-step checkpoints —
 *   the relay acks per chunk, so mid-run pod death loses at most the
 *   in-flight message, which the daemon's full-prefix resend replays).
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
        console.error("[link-ingest] Error saving messages", error);
      });
  };

  const { uiStream, whenComplete } = consumeHarnessStream({
    chunks,
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
      emitStepParts: async (responseMessage) => {
        if (!partEmitter) return;
        await partEmitter.emitStepParts(responseMessage);
      },
      emitFinal: async (responseMessage) => {
        if (partEmitter) {
          await partEmitter.emitFinal(responseMessage);
          return;
        }
        await saveMessagesToThread(responseMessage as ChatMessage);
      },
      emitError: async (messageId, errorText) => {
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
      // extracted from final message metadata. A relayed run without usage
      // metadata emits no completion event — model/mode/duration semantics
      // from dispatch-run's richer event need the wire input, absent here.
      onUsage: (totals) => {
        posthog.capture({
          distinctId,
          event: "chat_message_completed",
          groups: { organization: orgId },
          properties: {
            organization_id: orgId,
            thread_id: runId,
            transport: "pull-relay",
            input_tokens: totals.inputTokens,
            output_tokens: totals.outputTokens,
            total_tokens: totals.totalTokens,
          },
        });
      },
      onError: async (error) => {
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
      },
    },
  });

  // `pump` is the SOLE consumer of `uiStream` (never tee it). A non-null tail
  // means JetStream is live (pump consumes uiStream + the tail mirrors it for
  // /stream); a null tail means no JetStream, so drain uiStream directly so
  // parts still commit. Either way `whenComplete` is the authoritative "all
  // durable effects committed" signal. The signal is session-scoped (a relay
  // session spans many HTTP requests, so no request signal applies).
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
  await whenComplete;

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

    return { ctx, runId, thread };
  }

  app.post("/links/runs/:runId/chunks", async (c) => {
    const access = await validateRunAccess(c);
    if (access instanceof Response) return access;
    const { ctx, runId, thread } = access;

    const body = c.req.raw.body;
    if (!body) return c.json({ error: "missing body" }, 400);

    let session = relayRegistry.get(runId);
    if (!session) {
      const relayFrom = Number(c.req.header("x-relay-from") ?? "1");
      if (relayFrom > 1) {
        // The daemon is resuming a relay this pod has no session for — the
        // in-memory registry was lost (pod restart/crash). Terminal by
        // design: 4xx makes the daemon give up; the idle reaper fails the
        // run.
        return c.json({ error: "relay_session_lost" }, 410);
      }
      session = relayRegistry.open(runId, {
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
