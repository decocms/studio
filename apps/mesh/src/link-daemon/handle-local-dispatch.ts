/**
 * handleLocalDispatch — relay a pulled work item to the local sandbox and
 * stream its raw chunk output back to the cluster.
 *
 * The local sandbox streams SSE over loopback. The desktop link daemon
 * forwards every `DispatchSSEEvent` verbatim to the cluster as seq-numbered
 * NDJSON relay lines (see `chunk-relay.ts`), so the cluster-side harness
 * kernel is the single consumer of harness output — titles, usage, and
 * session metadata survive because the daemon no longer folds chunks into
 * part rows. The relay buffers all unacked lines and, when the streaming
 * upload drops, reconnects and resends the whole prefix from seq 1 (the
 * cluster dedupes by seq), so multi-hour runs survive transient drops.
 *
 * Flow:
 *   1. POST ${sandboxDispatchUrl}/_sandbox/dispatch with a JSON body of shape:
 *        { harnessId: <id>, input: <HarnessStreamInputWire> }
 *      The local sandbox daemon authenticates the request via Bearer
 *      `sandboxDaemonToken` and returns a `text/event-stream` SSE body of
 *      `ui-message-chunk` / `error` / `done` events.
 *
 *   2. Relay the SSE body to JetStream as seq-keyed stream envelopes: each
 *      `RelayLine` is published to `decopilot.stream.<runId>` over the daemon's
 *      active NATS connection (`{ p: chunk }` for content — error events are
 *      converted to error chunks — and `{ done, finalSeq }` for the terminal
 *      marker) with deterministic `Nats-Msg-Id`s so an at-least-once resend
 *      dedupes. The durable projector is the sole consumer that materializes
 *      parts/title/status from that log.
 *
 * ⚠️ ORG SLUG vs ID NOTE:
 *   WorkItem carries `orgId` (the DB UUID) and `orgSlug` (the URL-safe slug).
 *   The chunks route uses `resolveOrgFromPath` which looks up the org by slug
 *   (the `:org` path segment in `/api/:org/links/runs/...`). The work item's
 *   `orgSlug` is authoritative for the relay URL.
 *
 * ⚠️ HARNESS ID NOTE:
 *   `WorkItem.harnessInput` is a `HarnessStreamInputWire`. As of link
 *   protocol v2 the cluster sets the first-class top-level `harnessId`
 *   field on every dispatch — that is the primary path (see
 *   `deriveHarnessId`). The fallback chain (agent.id → "claude-code") is
 *   defense-in-depth only and can die with the next protocol bump. Callers
 *   can override via `deps.harnessId` if they know the correct value.
 *
 * ⚠️ SHIPPED DAEMON — needs human review before merge.
 */
import { jetstream } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/nats-core";
import type { WorkItem } from "../links/link-work-item";
import { relayDispatchSSEAsChunkStream } from "./chunk-relay";
import {
  createDirectNatsPublisher,
  type DirectNatsPublisher,
  publishRelayBodyToNats,
} from "./direct-nats-publisher";
import type { Outbox } from "./outbox";

const DISPATCH_START_TIMEOUT_MS = 15_000;

/**
 * Resolve the CURRENT live NATS connection for a relay publish, throwing a
 * labeled error if none is available. The getter is re-invoked per publish
 * attempt so an in-flight run survives a tunnel-session renewal (which recycles
 * the connection).
 */
function requireLiveNc(nc: NatsConnection | null): NatsConnection {
  if (!nc) {
    throw new Error(
      "[handleLocalDispatch] no live NATS connection for relay publish",
    );
  }
  return nc;
}

/**
 * Relay retry budget, env-tunable for ops without a rebuild (undefined → the
 * widened chunk-relay defaults: 12 attempts / 30s max backoff ≈ 2.5 min). The
 * wide window lets a transient cluster/edge ECONNRESET recover instead of
 * exhausting the budget and failing the run. `Number("")`/`Number(undefined)`
 * collapse to NaN → `|| undefined`, so an unset/blank env keeps the defaults.
 */
const RELAY_MAX_ATTEMPTS =
  Number(process.env.DECO_LINK_RELAY_MAX_ATTEMPTS) || undefined;
const RELAY_MAX_TIMEOUT_MS =
  Number(process.env.DECO_LINK_RELAY_MAX_TIMEOUT_MS) || undefined;

/**
 * Relay a synthesized terminal failure for a work item that cannot run
 * (expired credentials, etc.) by publishing directly to JetStream, so the
 * cluster kernel persists the failure and the gate unblocks.
 *
 * Publishes exactly:
 *   seq 1 — error event (converted to `{p:{type:"error",errorText}}`)
 *   done  — `{done:true,finalSeq:1}`
 *
 * Security note: `code` and `message` are informational strings — they must
 * never contain the fence token, API keys, or any other secret from the work
 * item. This function deliberately does NOT log any secret fields.
 */
export async function relayWorkItemFailure(
  work: WorkItem,
  deps: {
    getNatsConnection: () => NatsConnection | null;
    relayPublisher?: DirectNatsPublisher;
  },
  code: string,
  message: string,
): Promise<void> {
  const publisher =
    deps.relayPublisher ??
    createDirectNatsPublisher({
      js: jetstream(requireLiveNc(deps.getNatsConnection())),
    });
  await publisher.publishLine({
    runId: work.runId,
    fenceToken: work.runFenceToken,
    line: { seq: 1, event: { type: "error", code, message } },
  });
  await publisher.publishDone({
    runId: work.runId,
    fenceToken: work.runFenceToken,
    finalSeq: 1,
  });
}

export interface LocalDispatchDeps {
  /**
   * Base URL of the local sandbox daemon (loopback), e.g.
   * "http://127.0.0.1:9123". Ensured by the caller before invoking
   * handleLocalDispatch.
   */
  sandboxDispatchUrl: string;
  /**
   * Bearer token for the local `/_sandbox/dispatch` endpoint. Generated at
   * sandbox spawn time (see DesktopSandboxProvider.daemonToken).
   */
  sandboxDaemonToken: string;
  /**
   * Optional override for the harness id sent in the dispatch POST body.
   * When omitted, derived from `work.harnessInput` (see module note).
   */
  harnessId?: string;
  /**
   * Injected fetch implementation. Defaults to global `fetch`.
   * Tests inject a stub here to avoid real HTTP.
   */
  fetchImpl?: typeof fetch;
  /**
   * Abort signal propagated to the sandbox dispatch fetch and the chunk relay
   * (which now publishes to JetStream rather than POSTing to the cluster).
   */
  signal?: AbortSignal;
  /**
   * Maximum time to wait for the local sandbox daemon to return dispatch
   * response headers. This is intentionally not a run timeout: once headers
   * arrive, the SSE body may stream for hours under `signal`.
   */
  dispatchStartTimeoutMs?: number;
  /**
   * Durable outbox for the chunk relay (spec §5.1). Opened once per daemon and
   * shared across dispatches; the relay appends every line here before send and
   * truncates the run's rows on terminal ack, so a reconnect — even across a
   * daemon restart — resends the unacked prefix. Required at this boundary so
   * production durability is never silently lost to the in-memory fallback.
   */
  outbox: Outbox;
  /**
   * Override the chunk-relay retry budget. Production leaves this unset → the
   * env-tunable widened defaults apply (so a transient ECONNRESET recovers).
   * Tests inject a fast budget to exercise retry-exhaustion without waiting on
   * the ~2.5 min production window.
   */
  relayRetry?: {
    maxAttempts?: number;
    minTimeout?: number;
    maxTimeout?: number;
    jitter?: number;
  };
  /**
   * Returns the CURRENT live NATS connection. Re-sourced per publish attempt
   * so an in-flight run survives a tunnel-session renewal (which recycles the
   * connection). The chunk relay and synthesized failure relay both publish
   * directly to JetStream built from this connection.
   */
  getNatsConnection: () => NatsConnection | null;
  /** Test seam. Production omits it → built from `jetstream(getNatsConnection())`. */
  relayPublisher?: DirectNatsPublisher;
}

/**
 * Derive the harness id from the work item.
 *
 * Primary path: `work.harnessInput.harnessId` — first-class on the wire as
 * of link protocol v2 and always set by v2 dispatch. The rest of the chain
 * is defense-in-depth only and can die with the next protocol bump:
 *   1. `deps.harnessId` — explicit caller override.
 *   2. `work.harnessInput.harnessId` — the v2 wire field (primary).
 *   3. `work.harnessInput.agent.id` — older dispatchers set this to the
 *      harness type string (e.g. "claude-code", "codex").
 *   4. "claude-code" — the canonical desktop harness fallback.
 */
function deriveHarnessId(work: WorkItem, depsHarnessId?: string): string {
  if (depsHarnessId) return depsHarnessId;
  const input = work.harnessInput as Record<string, unknown>;
  if (typeof input.harnessId === "string" && input.harnessId.length > 0) {
    return input.harnessId;
  }
  const agent = input.agent as Record<string, unknown> | undefined;
  if (typeof agent?.id === "string" && agent.id.length > 0) {
    return agent.id;
  }
  return "claude-code";
}

/**
 * Run a pulled work item against the local sandbox and relay its raw SSE
 * events to the cluster chunks endpoint as seq-numbered NDJSON. Resolves when
 * a relay upload completes successfully after the terminal `done` line.
 * Throws on:
 *   - A non-2xx response from the sandbox dispatch (JSON error is extracted
 *     and included in the thrown Error).
 *   - A permanent relay failure (non-retriable 4xx, or 5 failed attempts).
 *   - Relay buffer overflow (RELAY_BUFFER_MAX_BYTES) or abort.
 */
export async function handleLocalDispatch(
  work: WorkItem,
  deps: LocalDispatchDeps,
): Promise<void> {
  const fetcher = deps.fetchImpl ?? fetch;
  const harnessId = deriveHarnessId(work, deps.harnessId);
  const dispatchStartTimeoutMs =
    deps.dispatchStartTimeoutMs ?? DISPATCH_START_TIMEOUT_MS;

  // ── Step 1: POST to the local sandbox daemon's /_sandbox/dispatch ──────
  // Body shape: { harnessId, input } or, when the cluster offloaded messages,
  // { harnessId, input, messagesRef }. `work.harnessInput` IS the
  // HarnessStreamInputWire (messages:[] when offloaded). The sandbox daemon
  // validates input against harnessStreamInputSchema and re-inflates messages
  // from messagesRef when present.
  const dispatchBody = work.messagesRef
    ? JSON.stringify({
        runId: work.runId,
        harnessId,
        input: work.harnessInput,
        messagesRef: work.messagesRef,
      })
    : JSON.stringify({
        runId: work.runId,
        harnessId,
        input: work.harnessInput,
      });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutController = new AbortController();
  const dispatchSignal = deps.signal
    ? AbortSignal.any([deps.signal, timeoutController.signal])
    : timeoutController.signal;
  if (Number.isFinite(dispatchStartTimeoutMs) && dispatchStartTimeoutMs > 0) {
    timeoutId = setTimeout(() => {
      timeoutController.abort(
        new DOMException(
          `sandbox dispatch did not respond within ${dispatchStartTimeoutMs}ms`,
          "TimeoutError",
        ),
      );
    }, dispatchStartTimeoutMs);
  }

  // `timeout: false` is a Bun fetch option (not in the standard RequestInit).
  // Bun default-times-out a long-lived stream, but the harness SSE legitimately
  // idles for minutes during a slow tool call or deep reasoning — without this
  // the body read trips `TimeoutError: The operation timed out` and the whole
  // turn dies as `local_dispatch_failed` (observed on both codex AND claude-code).
  // A genuine hang is still bounded by the run abort signal + the cluster
  // reaper. Matches the agent-sandbox client (provider/agent-sandbox/client.ts).
  const dispatchInit: RequestInit & { timeout?: boolean } = {
    method: "POST",
    headers: {
      authorization: `Bearer ${deps.sandboxDaemonToken}`,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: dispatchBody,
    signal: dispatchSignal,
    timeout: false,
  };
  let dispatchRes: Response;
  try {
    dispatchRes = await fetcher(
      `${deps.sandboxDispatchUrl}/_sandbox/dispatch`,
      dispatchInit as RequestInit,
    );
  } catch (err) {
    if (timeoutController.signal.aborted && !deps.signal?.aborted) {
      throw new Error(
        `[handleLocalDispatch] dispatch start timed out after ${dispatchStartTimeoutMs}ms`,
        { cause: err },
      );
    }
    // SANDBOX leg: opening the loopback dispatch SSE threw (e.g. the sandbox
    // daemon died / reset → "socket connection closed unexpectedly"). Label it
    // so it's distinguishable from a CLUSTER-RELAY failure in link.log. Quiet
    // on an intentional abort (cancel/shutdown).
    if (!deps.signal?.aborted) {
      console.error(
        `[relay-diag] SANDBOX dispatch-open threw runId=${work.runId} url=${deps.sandboxDispatchUrl}/_sandbox/dispatch name=${err instanceof Error ? err.name : typeof err} msg=${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw err;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }

  // Non-2xx handling: read the JSON error body and throw BEFORE any SSE
  // parsing so a failed run never looks successful (an error Response carries
  // no `data:` lines, so feeding it to the parser would yield a silent-empty
  // stream).
  if (!dispatchRes.ok) {
    let detail = `dispatch failed (${dispatchRes.status})`;
    try {
      const j = (await dispatchRes.json()) as Record<string, unknown>;
      if (j && typeof j.error === "string" && j.error) {
        detail = j.error;
      }
    } catch {
      // JSON parse failed — keep the status-code detail.
    }
    throw new Error(`[handleLocalDispatch] ${detail}`);
  }

  if (!dispatchRes.body) {
    throw new Error("[handleLocalDispatch] dispatch response body is null");
  }

  // ── Step 2: relay raw chunk lines directly to JetStream ────────────────
  // Retry/backoff and full-prefix resend live inside the chunk relay; this
  // post impl publishes the buffered prefix to NATS (JetStream dedupes by
  // msgID, so resending the whole prefix on reconnect is safe).
  await relayDispatchSSEAsChunkStream({
    dispatchBody: dispatchRes.body,
    runId: work.runId,
    fenceToken: work.runFenceToken,
    outbox: deps.outbox,
    signal: deps.signal,
    // Injected budget wins (tests); else env-tunable widened defaults. Either
    // way, undefined entries fall back to chunk-relay's defaults.
    retry: deps.relayRetry ?? {
      maxAttempts: RELAY_MAX_ATTEMPTS,
      maxTimeout: RELAY_MAX_TIMEOUT_MS,
    },
    post: async (body, _fromSeq, onDurablyPublished) => {
      // Build the publisher PER attempt so a retry after a tunnel-session
      // renewal re-sources the NEW live connection (the prior one is closed).
      const publisher =
        deps.relayPublisher ??
        createDirectNatsPublisher({
          js: jetstream(requireLiveNc(deps.getNatsConnection())),
        });
      const { lastSeq } = await publishRelayBodyToNats({
        body,
        runId: work.runId,
        fenceToken: work.runFenceToken,
        publisher,
        // Each publishLine awaits its JetStream PubAck, so a reported seq is
        // durable — let the relay drop that prefix from the outbox.
        onPublished: onDurablyPublished,
      });
      return { ok: true, lastSeq };
    },
  });
}
