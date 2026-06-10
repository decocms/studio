/**
 * chunk-relay — daemon side of the chunk-relay return path (link protocol v2,
 * spec "Transport Convergence").
 *
 * The local sandbox streams `DispatchSSEEvent`s over loopback SSE. The relay
 * forwards every event verbatim to the cluster as a seq-numbered NDJSON
 * `RelayLine`, so the cluster-side harness kernel is the only consumer of
 * harness output — titles, usage, and session metadata survive because the
 * daemon no longer folds chunks into part rows.
 *
 * Reconnect/backfill contract:
 * - STREAMING-FIRST: a POST attempt is opened immediately and each line is
 *   written as the SSE event arrives, so the cluster sees per-chunk progress
 *   (run liveness) instead of per-step batches.
 * - The cluster acks only once per POST, after the body ends
 *   (`RelayPostResult`). Every line therefore stays in an in-memory buffer
 *   until a POST attempt succeeds after the terminal line was sent.
 * - On a failed POST (connection drop, 5xx) the relay retries with backoff;
 *   each new attempt resends the WHOLE buffered prefix from seq 1
 *   (`fromSeq: 1`) and then continues streaming live lines. The cluster
 *   dedupes by seq, so resending is always safe.
 * - Pump progress is independent of POST health: while disconnected the
 *   sandbox keeps streaming and lines accumulate in the buffer, up to
 *   `RELAY_BUFFER_MAX_BYTES` — beyond that the run fails loudly (with the
 *   runId) rather than ballooning daemon memory. Because acks are terminal,
 *   the cap also bounds the total relayable size of a single run.
 * - If the sandbox stream ends without a `done` event, the relay synthesizes
 *   a terminal `{type:"done"}` line so the cluster always sees a terminal.
 * - Aborting `signal` tears everything down: the sandbox SSE source is
 *   cancelled, in-flight/queued POST attempts stop, and the relay rejects
 *   with the abort reason.
 */
import { retry, RetryError } from "@decocms/std";
import { parseDispatchSSEEvents } from "../harnesses/parse-dispatch-sse";
import type { DispatchSSEEvent } from "../links/protocol";
import {
  RELAY_BUFFER_MAX_BYTES,
  type RelayLine,
} from "../links/protocol/relay";

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
  ) => Promise<RelayPostResult>;
  signal?: AbortSignal;
}

const encoder = new TextEncoder();

/**
 * Relay a sandbox dispatch SSE body to the cluster as seq-numbered NDJSON
 * relay lines. Resolves when a POST attempt succeeds after the terminal line
 * was sent; rejects on permanent post failure, buffer overflow, source
 * failure, or abort.
 */
export async function relayDispatchSSEAsChunkStream(
  input: RelayDispatchSSEAsChunkStreamInput,
): Promise<void> {
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
  // `lines[i]` is the serialized NDJSON line for seq i+1. Lines are never
  // evicted mid-run (terminal-ack protocol), so `lines` always holds the full
  // resendable prefix.
  const lines: string[] = [];
  let bufferedBytes = 0;
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
    const line = `${JSON.stringify({ seq, event } satisfies RelayLine)}\n`;
    bufferedBytes += encoder.encode(line).byteLength;
    if (bufferedBytes > RELAY_BUFFER_MAX_BYTES) {
      throw new Error(
        `[chunk-relay] runId=${input.runId}: relay buffer exceeded ` +
          `RELAY_BUFFER_MAX_BYTES (${RELAY_BUFFER_MAX_BYTES} bytes) at seq ${seq} ` +
          `— failing the run instead of ballooning daemon memory`,
      );
    }
    lines.push(line);
    signalChange();
  };

  // ── Pump: sandbox SSE → buffered relay lines ─────────────────────────────
  // Runs independently of POST health so the buffer keeps absorbing the
  // sandbox stream while the cluster connection is down.
  const pumpPromise = (async () => {
    let sawDone = false;
    for await (const event of parseDispatchSSEEvents(input.dispatchBody, {
      signal: internal.signal,
    })) {
      pushLine(event);
      if (event.type === "done") sawDone = true;
    }
    if (!sawDone) pushLine({ type: "done" });
    pumpDone = true;
    signalChange();
  })().catch((err: unknown) => {
    pumpError =
      err ?? new Error(`[chunk-relay] runId=${input.runId}: chunk pump failed`);
    signalChange(); // wake attempt bodies so they error out promptly
    failWith(pumpError);
    throw pumpError;
  });

  // ── Attempt bodies: replay the buffered prefix, then follow live ─────────
  const createAttemptBody = (): ReadableStream<Uint8Array> => {
    let cursor = 0; // index into `lines` — always starts at seq 1
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
          if (cursor < lines.length) {
            const line = lines[cursor]!;
            cursor += 1;
            try {
              controller.enqueue(encoder.encode(line));
            } catch {
              // The consumer cancelled this attempt's upload (dropped POST) —
              // the line stays buffered for the next attempt.
            }
            return;
          }
          if (pumpDone) {
            controller.close();
            return;
          }
          await waiter;
        }
      },
    });
  };

  // ── Poster: streaming POST attempts with backoff + full-prefix resend ────
  const postOnce = async (): Promise<void> => {
    if (pumpError !== null) throw pumpError;
    const result = await input.post(createAttemptBody(), 1);
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
  };

  const posterPromise = retry(postOnce, {
    maxAttempts: 5,
    minTimeout: 250,
    maxTimeout: 5_000,
    signal: internal.signal,
    isRetriable: (err) => {
      // A pump failure is the root cause — retrying the POST cannot fix it.
      if (pumpError !== null && err === pumpError) return false;
      const status = (err as { status?: number }).status;
      return status === undefined || status >= 500;
    },
  }).catch((err: unknown) => {
    const cause = err instanceof RetryError ? err.cause : err;
    failWith(cause);
    throw cause;
  });

  const results = await Promise.allSettled([pumpPromise, posterPromise]);
  input.signal?.removeEventListener("abort", forwardAbort);

  if (results.some((r) => r.status === "rejected")) {
    // Failure paths can leave the source unlocked but open (e.g. buffer
    // overflow exits the parse generator cleanly) — cancel it so the sandbox
    // stops streaming into the void. No-op if already cancelled/locked.
    void input.dispatchBody.cancel(rootCause).catch(() => {});
    throw (
      rootCause ?? new Error(`[chunk-relay] runId=${input.runId}: relay failed`)
    );
  }
}
