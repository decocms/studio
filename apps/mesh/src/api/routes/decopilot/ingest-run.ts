/**
 * The ONE shared ingest unit (spec §unified-pipeline / Phase B).
 *
 * Both execution paths — agent-sandbox (in-mesh) and user-desktop (relay) —
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
import type { UIMessageChunk } from "ai";
import {
  consumeHarnessStream,
  type HarnessStreamConsumerHooks,
  type HarnessStreamPersistence,
  type HarnessStreamTitleOptions,
} from "./consume-harness-stream";
import { buildChunkMsgId } from "./projector-stream-messages";
import { CHECKPOINT_DEBOUNCE_MS } from "./nats-stream-buffer";
import type { StreamBuffer } from "./stream-buffer";

export interface IngestRunInput {
  runId: string;
  fenceToken: string;
  chunks: AsyncIterable<{ seq: number; chunk: UIMessageChunk }>;
  /** Re-checked per chunk; when it returns false the chunk is dropped (no
   *  publish, no hook). Defaults to always-true. */
  fenceOk?: () => boolean | Promise<boolean>;
  /** Fired after a NEW (deduped) chunk's publish is confirmed and the
   *  contiguous `ackSeq` floor has advanced. */
  onPublished?: (seq: number) => void;
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
  /** Deterministic id for a synthesized error message (`error-${runId}`) so the
   *  live write and the projector backstop dedupe it. See consumeHarnessStream. */
  errorMessageId?: string;
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
   * no-op (legacy: the durable projector was the sole writer). The hosted
   * caller passes the run's PartEmitter so the message lands in the DB before
   * the stream closes — closing the read-after-stream gap where a reload showed
   * the just-streamed message missing until the async projector caught up. The
   * projector still re-projects from JetStream as an idempotent backstop
   * (deterministic row ids → ON CONFLICT DO NOTHING).
   */
  persistence?: HarnessStreamPersistence;
  /**
   * When set, the ingest side publishes debounced checkpoint markers after
   * each confirmed `ackSeq` advance. The projector consumer reacts to these
   * by enqueuing a partial projection pass (Tasks 8-9). Omitted in runs
   * where incremental projection is disabled.
   */
  checkpointPublisher?: (
    fenceToken: string,
    headSeq: number,
  ) => Promise<boolean>;
}

/** Default persistence: write nothing (legacy projector-only behavior). */
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
  let lastCheckpointAt = 0;
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
        await deps.streamBuffer.publishRawChunk(runId, chunk, {
          msgId: buildChunkMsgId({ runId, fenceToken, seq }),
        });
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
          input.onPublished?.(ackSeq);
          if (
            deps.checkpointPublisher &&
            Date.now() - lastCheckpointAt >= CHECKPOINT_DEBOUNCE_MS
          ) {
            lastCheckpointAt = Date.now();
            deps.checkpointPublisher(fenceToken, ackSeq).catch(() => {});
          }
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
    title: deps.title,
    persistence: deps.persistence ?? NOOP_PERSISTENCE,
    hooks: deps.hooks,
    errorMessageId: input.errorMessageId,
  });

  await drain(uiStream);
  await whenComplete;

  // A source/publish throw poisons the run: re-raise so the caller fails and we
  // never stamp a {done} marker on a partial run.
  if (sourceError !== undefined) throw sourceError;

  // Authoritative terminal sentinel: published ONLY after a clean run (no throw
  // from the source stream or the kernel), fence-scoped so the projector keys
  // {done} under the same `${runId}:${fenceToken}` namespace as the content
  // chunks. `ackSeq` is the highest contiguous published seq.
  if (ackSeq > 0) {
    await deps.streamBuffer.publishDone(runId, fenceToken, ackSeq);
  }
}
