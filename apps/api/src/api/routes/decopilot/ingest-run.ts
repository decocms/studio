/**
 * The ONE shared ingest unit (spec §unified-pipeline / Phase B).
 *
 * Both execution paths — agent-sandbox (in-studio) and user-desktop (relay) —
 * route through `ingestRun`. It does two things, in lockstep, per chunk:
 *
 *  1. **Publish** the raw chunk to `DECOPILOT_STREAMS` with a seq-keyed
 *     `Nats-Msg-Id` (`${runId}:${fenceToken}:${seq}`) so an at-least-once
 *     producer (outbox replay) can re-publish without double-writing. The
 *     projector (Phase A) is the SOLE writer of parts + status + title from
 *     that NATS log — `ingestRun` itself does ZERO DB writes.
 *  2. **Drive the live hooks** (usage, posthog completion, SSE finish) and the
 *     title-chunk injection by feeding the *deduped* chunk stream through the
 *     harness kernel (`consumeHarnessStream`) with NO-OP persistence. Hooks +
 *     title injection fire EXACTLY ONCE per logical chunk because the dedup
 *     happens before the kernel ever sees a replay.
 *
 * Dedup policy is ported verbatim from `links/uplink-ingest.ts`: a rolling
 * CONTIGUOUS `ackSeq` (highest seq with all <= it publish-confirmed) plus a
 * `pending` set for out-of-order arrivals. A seq already at/below `ackSeq` is a
 * replayed prefix → skipped (no publish, no hook).
 *
 * Pure: the stream buffer, hooks, title options, and `fenceOk` are injected, so
 * this is a unit (no StudioContext, no NATS, no DB).
 */
import type { UIMessage, UIMessageChunk } from "ai";
import {
  consumeHarnessStream,
  type HarnessStreamConsumerHooks,
  type HarnessStreamPersistence,
  type HarnessStreamTitleOptions,
} from "./consume-harness-stream";
import type { StreamBuffer } from "./stream-buffer";

export interface IngestRunInput {
  runId: string;
  fenceToken: string;
  chunks: AsyncIterable<{ seq: number; chunk: UIMessageChunk }>;
  /** Re-checked per chunk; when it returns false the chunk is dropped (no
   *  publish, no hook). Defaults to always-true. */
  fenceOk?: () => boolean | Promise<boolean>;
  /**
   * Fired after a NEW (deduped) chunk's publish is confirmed and the contiguous
   * `ackSeq` floor has advanced. AWAITED: a caller that persists the floor as a
   * durable resume point (see `initialAckSeq`) needs the write to land before
   * the next chunk publishes — a floor that lags the stream by even one chunk
   * makes the next attempt start below what this one already published, and
   * those seqs are then dropped as duplicates.
   */
  onPublished?: (seq: number) => void | Promise<void>;
  /**
   * Durable resume floor: the contiguous acked seq already in JetStream from a
   * prior session (read from `getAckedSeq` at session-open time). Chunks with
   * `seq <= initialAckSeq` are skipped — no publish, no `onPublished`, no yield
   * to the kernel — because they are already durably stored in JetStream with
   * msgIds `${runId}:${fenceToken}:1..initialAckSeq`. The tail `initialAckSeq+1..N`
   * publishes with its real seq, so msgIds remain contiguous across sessions.
   * Defaults to 0 (fresh run: publish everything from seq 1).
   */
  initialAckSeq?: number;
  /** Deterministic id for a synthesized error message (`error-${runId}`) so
   *  projector-only persistence dedupes retries. See consumeHarnessStream. */
  errorMessageId?: string;
  /**
   * Trailing window of prior persisted messages, used ONLY to SEED the hook
   * reassembly (`consumeHarnessStream`). For a tool-approval CONTINUATION run
   * the trailing message is the assistant "proposal" still holding the pending
   * tool part; seeding it lets the continuation's `tool-output` chunk reconcile
   * (and adopt the proposal id via `continuationMessageId`) instead of throwing
   * `No tool invocation found`. Mirrors the durable projector, which seeds the
   * same way from `loadWindow`. Undefined/empty for fresh turns (the trailing
   * message is the user's, so no continuation merge happens). Only `.at(-1)` is
   * consulted — a single-message window suffices.
   */
  originalMessages?: UIMessage[];
}

/**
 * Duck-typed shape a caller can read off a caught `ingestRun` failure (see
 * `ingestRun`'s `sourceError` handling below). `lastAckSeq` is the highest
 * CONTIGUOUS published seq at the moment of failure (0 if no chunk was ever
 * confirmed) — a caller that must publish its own fence-scoped terminal after
 * catching this (see `hosted-harness-workflow.ts`'s `publishHostedHarnessFailure`)
 * needs it to pick a seq that keeps the run's JetStream log contiguous instead
 * of colliding with (or leaving a gap before) already-published content chunks.
 *
 * Plain own-enumerable property, not a class/`instanceof` check — DBOS
 * serializes a step's thrown error through `serialize-error` for its durable
 * journal and reconstructs a plain `Error` on replay (losing any subclass),
 * but own-enumerable properties survive that round trip. Same idiom as
 * `PermanentRunError.permanent` (see `core/dispatch-errors.ts`).
 */
export interface WithLastAckSeq {
  lastAckSeq?: number;
}

export interface IngestRunDeps {
  streamBuffer: Pick<StreamBuffer, "publishRawChunk" | "publishDone">;
  /** usage / onFinish / onError → posthog / SSE; the caller wires them. */
  hooks: HarnessStreamConsumerHooks;
  /** Injects the title chunk; `persistTitle` is a NO-OP here — the projector
   *  is the sole title writer. */
  title: HarnessStreamTitleOptions;
  /**
   * Persists the assistant message parts as the run streams. Defaults to the
   * no-op (the durable projector is the sole writer for the desktop/relay
   * path). The hosted background-job caller passes its PartEmitter so the
   * message lands in the DB before the stream closes; the projector still
   * re-projects from JetStream as an idempotent backstop (stable row
   * ids → ON CONFLICT DO NOTHING).
   */
  persistence?: HarnessStreamPersistence;
}

/** Default persistence: write nothing — the durable projector is the sole
 *  writer (desktop/relay path). Hosted background jobs override via deps. */
const NOOP_PERSISTENCE: HarnessStreamPersistence = {
  emitStepParts: async () => {},
  emitFinal: async () => {},
  emitError: async () => {},
};

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

export async function ingestRun(
  input: IngestRunInput,
  deps: IngestRunDeps,
): Promise<void> {
  const { runId, fenceToken } = input;
  const fenceOk = input.fenceOk ?? (() => true);

  // Rolling contiguous floor + out-of-order pending set (uplink-ingest policy).
  // Seeded from `initialAckSeq` (durable resume floor) so the already-published
  // prefix 1..initialAckSeq is skipped without re-publishing (same msgIds would
  // collide in JetStream dedup, silently dropping the run's tail).
  let ackSeq = input.initialAckSeq ?? 0;
  const pending = new Set<number>();
  // Captures a throw from the source stream (or the publish leg). The kernel
  // turns it into a wire error chunk and closes cleanly, so it never surfaces
  // as a rejection on its own — we re-raise it after `whenComplete` to (a) keep
  // the run from being marked {done} and (b) propagate failure to the caller.
  let sourceError: unknown;

  // The deduped chunk stream: publish-then-yield, in lockstep with the kernel's
  // pull. Each NEW chunk is published (awaited) with its seq-keyed msgId before
  // it reaches the kernel, so hooks + title injection see it exactly once.
  async function* dedupedChunks(): AsyncGenerator<UIMessageChunk> {
    try {
      for await (const { seq, chunk } of input.chunks) {
        if (!(await fenceOk())) continue;
        // Replayed prefix already contiguous-acked, or a duplicate still pending.
        if (seq <= ackSeq || pending.has(seq)) continue;
        if (
          !(await deps.streamBuffer.publishRawChunk(runId, chunk, {
            fenceToken,
            seq,
          }))
        ) {
          throw new Error("publishRawChunk failed");
        }
        pending.add(seq);
        // Advance the contiguous floor as far as the pending set allows.
        const prevAckSeq = ackSeq;
        while (pending.has(ackSeq + 1)) {
          pending.delete(ackSeq + 1);
          ackSeq += 1;
        }
        // Fire onPublished with the NEW contiguous floor only when it actually
        // advanced — so callers can use the value directly as a durable
        // high-water mark (no out-of-order gaps). On in-order delivery
        // ackSeq == seq every time; on out-of-order delivery ackSeq advances to
        // the filled contiguous boundary when the gap is closed.
        if (ackSeq > prevAckSeq) {
          await input.onPublished?.(ackSeq);
        }
        yield chunk;
      }
    } catch (err) {
      sourceError = err;
      throw err;
    }
  }

  const { uiStream, whenComplete } = consumeHarnessStream({
    chunks: dedupedChunks(),
    originalMessages: input.originalMessages,
    title: {
      ...deps.title,
      persistTitle: async () => {},
    },
    persistence: deps.persistence ?? NOOP_PERSISTENCE,
    hooks: deps.hooks,
    errorMessageId: input.errorMessageId,
  });

  await drain(uiStream);
  await whenComplete;

  // A source/publish throw poisons the run: re-raise so the caller fails and we
  // never stamp a {done} marker on a partial run. Stamp the highest contiguous
  // published seq onto the error first (see `WithLastAckSeq`) so a caller that
  // must publish its own terminal after this (the hosted-harness child's catch)
  // can continue the run's seq counter instead of colliding with seq 1..ackSeq.
  if (sourceError !== undefined) {
    if (sourceError instanceof Error) {
      (sourceError as Error & WithLastAckSeq).lastAckSeq = ackSeq;
    }
    throw sourceError;
  }

  // Authoritative terminal sentinel: published ONLY after a clean run (no throw
  // from the source stream or the kernel), fence-scoped so the projector keys
  // {done} under the same `${runId}:${fenceToken}` namespace as the content
  // chunks. `ackSeq` is the highest contiguous published seq.
  if (ackSeq > 0) {
    await deps.streamBuffer.publishDone(runId, fenceToken, ackSeq);
  }
}
