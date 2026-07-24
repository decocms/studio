/**
 * chunk-relay — daemon side of the chunk-relay return path (link protocol v2,
 * spec "Transport Convergence").
 *
 * The local sandbox streams `DispatchSSEEvent`s over loopback SSE. The relay
 * forwards every event as a seq-numbered NDJSON `RelayLine` to an injected
 * `post` sink. Production wires that sink to direct JetStream publishing (see
 * `handle-local-dispatch` + `direct-nats-publisher`), so each line lands on
 * `decopilot.stream.<runId>` and the durable projector is the sole consumer of
 * harness output — titles, usage, and session metadata survive because the
 * daemon no longer folds chunks into part rows.
 *
 * Reconnect/backfill contract (sink-agnostic):
 * - STREAMING-FIRST: a sink attempt is opened immediately and each line is
 *   written as the SSE event arrives, so the consumer sees per-chunk progress
 *   (run liveness) instead of per-step batches.
 * - ROLLING TRUNCATION: a sink reports durably-published seqs via the
 *   `onDurablyPublished` callback (the per-line NATS sink fires it on PubAck);
 *   the relay drops that confirmed prefix from the outbox as it goes, so the
 *   buffer holds only the in-flight (unconfirmed) window — not the whole run.
 *   The terminal `RelayPostResult` ack then truncates whatever tail remains. A
 *   sink that never reports keeps every line until terminal ack (old behavior).
 * - On a failed attempt (publish/connection drop) the relay retries with
 *   backoff; each new attempt resends the buffered prefix from `fromSeq: 1` —
 *   which after rolling truncation is the lowest still-unconfirmed seq (the
 *   confirmed prefix is already durable at the sink) — then continues streaming
 *   live lines. JetStream `Nats-Msg-Id` dedup makes resending always safe.
 * - Pump progress is independent of POST health: while disconnected the
 *   sandbox keeps streaming and lines accumulate in the buffer, up to
 *   `MAX_OUTBOX_BYTES` — beyond that the run fails loudly (with the runId)
 *   rather than ballooning disk. With rolling truncation that cap bounds the
 *   unconfirmed in-flight window (a stalled-publisher backstop), not the whole
 *   run's relayable size.
 * - If the sandbox stream ends without a `done` event, the relay synthesizes
 *   a terminal `{type:"done"}` line so the cluster always sees a terminal.
 * - Aborting `signal` tears everything down: the sandbox SSE source is
 *   cancelled, in-flight/queued POST attempts stop, and the relay rejects
 *   with the abort reason.
 *
 * LIVENESS HEARTBEATS (unified-control-plane T6, mirrors T5's hosted-executor
 * wrapper `apps/api/src/api/routes/decopilot/with-liveness-heartbeat.ts`):
 * while the pump below is actively pulling from the sandbox SSE, a
 * `HeartbeatEmitter` (`@decocms/harness/liveness-heartbeat` — the SAME
 * scheduler class T5 uses) injects a synthetic `data-liveness` relay line
 * through `pushLine` whenever `livenessHeartbeatMs` (default 30s) elapses
 * with no real `DispatchSSEEvent` — a long tool call or model wait on the
 * desktop harness with no incremental output. Because it goes through
 * `pushLine`, it consumes a REAL seq and is appended to the durable outbox
 * exactly like any other line, so it rides the same
 * dedup/resend/rolling-truncation contract and — critically — resets the
 * projector's per-pull idle window on the consume side
 * (`natsChunkSource`, unified-control-plane T4) just like any other message
 * on the run subject. See the `pumpPromise` wiring below for arm/stop
 * semantics. Version-skew note: an already-deployed daemon predating this
 * change never emits these — the cluster's `RUN_IDLE_TIMEOUT_MS` (10
 * minutes) is UNCHANGED here; this task only adds emission, not a threshold
 * change (see `packages/harness/src/liveness-heartbeat.ts` module doc).
 */
import { retry, RetryError, sleep } from "@decocms/shared/std";
import {
  buildLivenessChunk,
  HeartbeatEmitter,
} from "@decocms/harness/liveness-heartbeat";
import { parseDispatchSSEEvents } from "../harnesses/parse-dispatch-sse";
import type { DispatchSSEEvent } from "../links/protocol";
import type { RelayLine } from "../links/protocol/relay";
import { laneForEvent } from "./outbox-lane";
import { type Outbox, openInMemoryOutbox } from "./outbox";

/**
 * Cluster ack for one relay POST. `lastSeq` is the highest seq the cluster
 * persisted; if it trails the terminal seq the attempt is treated as failed
 * and the prefix is resent.
 */
export interface RelayPostResult {
  ok: boolean;
  lastSeq: number;
}

export interface RelayDispatchSSEAsChunkStreamInput {
  /** The local sandbox's `/_sandbox/dispatch` SSE response body. */
  dispatchBody: ReadableStream<Uint8Array>;
  runId: string;
  /**
   * Performs one POST attempt against the cluster `/chunks` endpoint. The
   * body is an NDJSON stream that replays the buffered prefix from `fromSeq`
   * and then follows the live relay; it resolves with the cluster's ack after
   * the body ends. MUST reject when the upload fails — non-2xx (attach the
   * HTTP status as `err.status`; only >= 500 is retried), network drop, or
   * the body stream erroring — a real `fetch` does all three.
   */
  post: (
    body: ReadableStream<Uint8Array> | string,
    fromSeq: number,
    /**
     * Reports the highest seq this attempt has DURABLY published (e.g. a
     * JetStream PubAck for the per-line NATS sink). The relay drops the
     * confirmed prefix from the outbox (rolling ackSeq truncation), so a long
     * run's buffer stays bounded to the in-flight window instead of the whole
     * run. Sinks whose lines are only durable at terminal ack (none today)
     * simply never call it. Called in seq order; the relay truncates up to the
     * value.
     */
    onDurablyPublished?: (ackSeq: number) => void,
  ) => Promise<RelayPostResult>;
  signal?: AbortSignal;
  /**
   * Single-writer fence token for this run — the outbox key epoch (spec §5.1).
   * Optional during the transition; defaults to a local sentinel when the relay
   * uses its own non-durable in-memory outbox.
   */
  fenceToken?: string;
  /**
   * Durable outbox. Every line is appended here BEFORE the POST body can read
   * it (append-before-send); on terminal ack the run's rows are truncated. The
   * on-disk successor to the old in-memory lines[] + RELAY_BUFFER_MAX_BYTES cap
   * — the cap now lives in the outbox (MAX_OUTBOX_BYTES, same 64 MiB). When
   * absent the relay opens a private :memory: outbox (no crash survival), so a
   * single code path drives both modes. Production injects a file-backed outbox
   * opened once per daemon.
   */
  outbox?: Outbox;
  /**
   * Retry policy for the streaming POST. The defaults widen the window to
   * ~2.5 min (vs the old 5-attempt/~8s budget) so a TRANSIENT cluster/edge
   * reset — confirmed in the field as a fast `ECONNRESET` with no response,
   * where all retries fall inside one brief reset window — is recovered
   * instead of failing the run. `jitter` de-synchronizes concurrent runs so
   * they don't retry in lockstep into the same window. Tests/ops override.
   */
  retry?: {
    maxAttempts?: number;
    minTimeout?: number;
    maxTimeout?: number;
    jitter?: number;
  };
  /**
   * Idle-gap keepalive interval for the streaming POST body, in ms. When the
   * relay has no new line to send for this long (a model think-gap / between
   * steps), it writes a blank NDJSON line (`"\n"`) into the request body so the
   * upload keeps emitting bytes. A long-lived streaming POST that writes nothing
   * during an idle gap is reset by an intermediary idle timeout — in the field a
   * Cloudflare edge ~15s idle timeout fires a fast `ECONNRESET` ("socket
   * connection closed unexpectedly"), and because each retry resends from seq 1
   * and goes idle again, a single >15s think-gap can make a run never finish.
   * The blank line is a no-op on the wire: the cluster's `ndjsonLines` parser
   * trims and skips empty lines, so it never becomes a relay line and seq
   * numbering / prefix-replay are untouched. Default 10s (margin under 15s);
   * tests override with a tiny value.
   */
  heartbeatMs?: number;
  /**
   * Liveness heartbeat interval (ms) — UNRELATED to `heartbeatMs` above
   * (that one is a transport-level blank-line keepalive that never becomes a
   * relay line). This one controls the `HeartbeatEmitter` silence window
   * (see the module doc's "LIVENESS HEARTBEATS" section): when the SANDBOX
   * SSE source itself goes silent this long, a REAL seq-numbered
   * `data-liveness` relay line is injected. Defaults to
   * `LIVENESS_HEARTBEAT_INTERVAL_MS` (30s, from
   * `@decocms/harness/liveness-heartbeat`); tests override with a tiny value
   * the same way the existing `heartbeatMs` tests do.
   */
  livenessHeartbeatMs?: number;
}

const encoder = new TextEncoder();

/** Default keepalive cadence — comfortably under the ~15s CDN idle timeout. */
const DEFAULT_HEARTBEAT_MS = 10_000;

/** Blank NDJSON line: keeps bytes flowing; the cluster parser skips it. */
const HEARTBEAT_BYTES = encoder.encode("\n");

/**
 * Relay a sandbox dispatch SSE body to the cluster as seq-numbered NDJSON
 * relay lines. Resolves when a POST attempt succeeds after the terminal line
 * was sent; rejects on permanent post failure, buffer overflow, source
 * failure, or abort.
 */
export async function relayDispatchSSEAsChunkStream(
  input: RelayDispatchSSEAsChunkStreamInput,
): Promise<void> {
  // The durable outbox is the resendable prefix. When the caller injects one
  // (production: a file-backed outbox opened once per daemon) we use it and the
  // caller owns its lifecycle; otherwise we open a private :memory: outbox and
  // close it on exit. Either way the relay drives a single Outbox code path.
  const outbox = input.outbox ?? openInMemoryOutbox();
  const ownsOutbox = input.outbox === undefined;
  const fenceToken = input.fenceToken ?? "local";

  // Internal abort fans a failure on either side (pump/poster) out to the
  // other: it cancels the SSE reader inside parseDispatchSSEEvents and
  // interrupts the poster's backoff delays.
  const internal = new AbortController();
  const forwardAbort = () => internal.abort(input.signal?.reason);
  if (input.signal?.aborted) internal.abort(input.signal.reason);
  else input.signal?.addEventListener("abort", forwardAbort, { once: true });

  /** First root-cause failure wins; everything after is downstream fallout. */
  let rootCause: unknown = null;
  const failWith = (err: unknown) => {
    if (rootCause === null) {
      rootCause =
        err ?? new Error(`[chunk-relay] runId=${input.runId}: relay failed`);
      internal.abort(rootCause);
    }
  };

  // ── Shared relay state ───────────────────────────────────────────────────
  // The durable outbox holds the full resendable prefix (never evicted mid-run
  // under the terminal-ack protocol). We keep only the cursor-side bookkeeping
  // in memory. `seq` is the wireSeq — today's relay seq, unchanged on the wire.
  let seq = 0;
  let pumpDone = false; // set ONLY when the pump finished successfully
  let pumpError: unknown = null;
  let change = Promise.withResolvers<void>();
  const signalChange = () => {
    const prev = change;
    change = Promise.withResolvers<void>();
    prev.resolve();
  };

  const pushLine = (event: DispatchSSEEvent): void => {
    seq += 1;
    const line: RelayLine = { seq, event };
    // append-before-send: the cap (MAX_OUTBOX_BYTES) lives in the outbox and
    // throws loudly here, preserving today's 64 MiB loud-fail contract.
    outbox.append({
      runId: input.runId,
      fenceToken,
      wireSeq: seq,
      lane: laneForEvent(event),
      line,
    });
    signalChange();
  };

  // ── Pump: sandbox SSE → buffered relay lines ─────────────────────────────
  // Runs independently of POST health so the buffer keeps absorbing the
  // sandbox stream while the cluster connection is down.
  //
  // Liveness heartbeat (see module doc "LIVENESS HEARTBEATS"): armed before
  // the loop starts (silence before the very first chunk counts too),
  // re-armed on every real event (a chunk/error/done arriving resets the
  // silence window), and stopped in `finally` on EVERY pump exit — normal
  // completion, a thrown error, or cancellation via `internal.signal` — so
  // it can never fire once the dispatch is no longer live. A heartbeat
  // firing calls `pushLine`, which assigns it the next real wire seq exactly
  // like any other event.
  // Failure-mode note: if a heartbeat's pushLine throws (e.g. the outbox's
  // MAX_OUTBOX_BYTES overflow cap), the emitter swallows it and permanently
  // stops for this run — liveness heartbeats silently end, but REAL content
  // hitting the same cap still fails the pump loudly, so the swallow can
  // never mask a genuine overflow. Bounded, accepted (heartbeat lines are
  // tiny relative to content).
  const heartbeat = new HeartbeatEmitter({
    intervalMs: input.livenessHeartbeatMs,
    emit: () => {
      pushLine({ type: "ui-message-chunk", chunk: buildLivenessChunk() });
    },
  });
  const pumpPromise = (async () => {
    let sawDone = false;
    try {
      heartbeat.arm();
      for await (const event of parseDispatchSSEEvents(input.dispatchBody, {
        signal: internal.signal,
      })) {
        pushLine(event);
        if (event.type === "done") sawDone = true;
        heartbeat.arm();
      }
      if (!sawDone) pushLine({ type: "done" });
      pumpDone = true;
      signalChange();
    } finally {
      heartbeat.stop();
    }
  })().catch((err: unknown) => {
    pumpError =
      err ?? new Error(`[chunk-relay] runId=${input.runId}: chunk pump failed`);
    // `rootCause === null` ⇒ this leg failed FIRST, so it is the real root.
    // (A poster failure aborts `internal`, which cancels the SSE reader and
    // lands here too — but then rootCause is already set, so we stay quiet.)
    if (rootCause === null) {
      // ROOT = SANDBOX leg: the loopback dispatch SSE broke (sandbox daemon
      // closed the stream / died → "socket connection closed unexpectedly").
      console.error(
        `[relay-diag] ROOT=SANDBOX-SSE-pump runId=${input.runId} name=${pumpError instanceof Error ? pumpError.name : typeof pumpError} msg=${pumpError instanceof Error ? pumpError.message : String(pumpError)}`,
      );
    }
    signalChange(); // wake attempt bodies so they error out promptly
    failWith(pumpError);
    throw pumpError;
  });

  const heartbeatMs = input.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  // ── Attempt bodies: replay the durable prefix, then follow live ──────────
  const createAttemptBody = (): ReadableStream<Uint8Array> => {
    let cursor = 0; // highest wireSeq already enqueued; replay from cursor+1
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        while (true) {
          // Capture the waiter BEFORE checking state: any pushLine after the
          // checks resolves this captured promise (no lost wakeups).
          const waiter = change.promise;
          if (pumpError !== null) {
            controller.error(pumpError);
            return;
          }
          const rows = outbox.replay({
            runId: input.runId,
            fenceToken,
            fromSeq: cursor + 1,
          });
          if (rows.length > 0) {
            for (const row of rows) {
              cursor = row.wireSeq;
              try {
                controller.enqueue(
                  encoder.encode(`${JSON.stringify(row.line)}\n`),
                );
              } catch {
                // The consumer cancelled this attempt's upload (dropped POST) —
                // the rows stay durable for the next attempt.
                return;
              }
            }
            return;
          }
          if (pumpDone) {
            controller.close();
            return;
          }
          // Idle: no buffered line and the pump is still running. Wait for the
          // next line, but if the gap exceeds `heartbeatMs` emit a blank-line
          // keepalive so the streaming upload keeps writing bytes and a CDN
          // idle timeout (Cloudflare ~15s) can't reset it. `sleep`'s timer is
          // cancelled (via its signal) the moment a line arrives, so an active
          // run never accumulates timers.
          const hbAbort = new AbortController();
          const winner = await Promise.race([
            waiter.then(() => "line" as const),
            sleep(heartbeatMs, { signal: hbAbort.signal })
              .then(() => "heartbeat" as const)
              // Aborted (a line won the race) → fall through and re-check state.
              .catch(() => "line" as const),
          ]);
          hbAbort.abort();
          if (winner === "heartbeat") {
            try {
              controller.enqueue(HEARTBEAT_BYTES);
            } catch {
              // Consumer cancelled this attempt's upload — durable rows remain.
              return;
            }
            return;
          }
        }
      },
    });
  };

  // ── Poster: streaming POST attempts with backoff + full-prefix resend ────
  const postOnce = async (): Promise<void> => {
    if (pumpError !== null) throw pumpError;
    // Rolling ackSeq truncation: as the sink confirms a line is durably
    // published, drop the prefix from the outbox so the buffer never holds more
    // than the unconfirmed in-flight window. The confirmed prefix is durable at
    // the sink (JetStream dedupes by msgId), so a resend never needs it.
    const onDurablyPublished = (ackSeq: number): void => {
      outbox.truncateUpToSeq({ runId: input.runId, fenceToken, ackSeq });
    };
    const result = await input.post(createAttemptBody(), 1, onDurablyPublished);
    if (pumpError !== null) throw pumpError;
    if (!result.ok) {
      throw new Error(
        `[chunk-relay] runId=${input.runId}: relay post returned ok=false (lastSeq=${result.lastSeq})`,
      );
    }
    if (!pumpDone) {
      // The body stream only closes once the pump finished — a success
      // response before that means the server stopped reading early.
      throw new Error(
        `[chunk-relay] runId=${input.runId}: relay post responded before the chunk stream completed`,
      );
    }
    if (result.lastSeq < seq) {
      throw new Error(
        `[chunk-relay] runId=${input.runId}: cluster acked lastSeq=${result.lastSeq} < terminal seq=${seq}`,
      );
    }
    // Terminal-acked: drop the whole run's durable rows (terminal-only
    // truncation, §13 step 2; rolling ackSeq truncation arrives with the WS
    // step). Frees the per-run/per-daemon byte budget for the next run.
    outbox.truncateRun({ runId: input.runId, fenceToken });
  };

  // Widened defaults (see the `retry` field doc): ~2.5 min total window so a
  // brief ECONNRESET reset window can't swallow the whole budget.
  const posterPromise = retry(postOnce, {
    maxAttempts: input.retry?.maxAttempts ?? 12,
    minTimeout: input.retry?.minTimeout ?? 250,
    maxTimeout: input.retry?.maxTimeout ?? 30_000,
    jitter: input.retry?.jitter ?? 0.5,
    signal: internal.signal,
    isRetriable: (err) => {
      // A pump failure is the root cause — retrying the POST cannot fix it.
      if (pumpError !== null && err === pumpError) return false;
      const status = (err as { status?: number }).status;
      // Network drops (ECONNRESET etc.) carry no `.status` → retriable; a 4xx
      // (fence/cancel) is permanent; 5xx is retriable.
      return status === undefined || status >= 500;
    },
  }).catch((err: unknown) => {
    const cause = err instanceof RetryError ? err.cause : err;
    // Only the FIRST failure is the root (see the pump catch above). A pump
    // failure that aborts an in-flight POST also lands here, but by then
    // rootCause is already set, so we don't mislabel it as a cluster fault.
    if (rootCause === null) {
      // ROOT = CLUSTER-RELAY leg: the streaming POST to the cluster failed
      // (after exhausting the retry budget) — socket reset, non-2xx, or ack
      // mismatch.
      console.error(
        `[relay-diag] ROOT=CLUSTER-RELAY runId=${input.runId} retried=${err instanceof RetryError} name=${cause instanceof Error ? cause.name : typeof cause} msg=${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    failWith(cause);
    throw cause;
  });

  try {
    const results = await Promise.allSettled([pumpPromise, posterPromise]);
    input.signal?.removeEventListener("abort", forwardAbort);

    if (results.some((r) => r.status === "rejected")) {
      // Failure paths can leave the source unlocked but open (e.g. buffer
      // overflow exits the parse generator cleanly) — cancel it so the sandbox
      // stops streaming into the void. No-op if already cancelled/locked.
      void input.dispatchBody.cancel(rootCause).catch(() => {});
      throw (
        rootCause ??
        new Error(`[chunk-relay] runId=${input.runId}: relay failed`)
      );
    }
  } finally {
    // A run's rows are useless once the relay returns: SUCCESS means the cluster
    // acked them; FAILURE/ABORT means the run is dead (its sandbox SSE is
    // cancelled). Drop them on EVERY terminal outcome so a failed/aborted run
    // never leaks its prefix into the durable outbox — that leak (truncateRun
    // previously fired only on success) accumulated dead runs until the
    // daemon-wide MAX_OUTBOX_BYTES wedged the relay. Idempotent: the success
    // path already truncated inside postOnce.
    try {
      outbox.truncateRun({ runId: input.runId, fenceToken });
    } catch {
      // Cleanup must never mask the real terminal error.
    }
    // Close only an outbox we created; an injected one is the caller's to own.
    if (ownsOutbox) outbox.close();
  }
}
