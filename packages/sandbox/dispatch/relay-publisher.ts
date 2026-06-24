/**
 * Direct-NATS relay publisher — the producer half of the chunk-relay protocol
 * (spec: "Transport Convergence", protocol v2). A desktop daemon publishes each
 * seq-numbered RelayLine straight to the JetStream subject
 * `decopilot.stream.<runId>`; the always-on durable projector consumes it.
 *
 * This is the single source of truth for the wire format (subject + msgId
 * scheme + checkpoint debounce + envelope shapes), shared by:
 *   - the app's live producer (apps/mesh/src/link-daemon/direct-nats-publisher.ts,
 *     a thin adapter that injects OpenTelemetry metrics via `hooks`), and
 *   - the e2e "fake daemon" relay (packages/e2e/fixtures/relay-nats.ts).
 *
 * It is metrics-agnostic on purpose — observability is injected via optional
 * `hooks` so a test (no OTel meter wired) can drive it directly.
 */
import type { JetStreamClient } from "@nats-io/jetstream";
import { relayLineSchema, type RelayLine } from "./relay";

// --- Stream subject + msgId scheme -------------------------------------------

export const DECOPILOT_STREAM_SUBJECT_PREFIX = "decopilot.stream";

/** Debounce between incremental checkpoint markers, shared by BOTH producers
 *  (hosted ingest + desktop daemon relay). Single source of truth. */
export const CHECKPOINT_DEBOUNCE_MS = 3000;

function assertSafeSubjectToken(id: string): void {
  if (/[.*>\s]/.test(id)) throw new Error("Invalid NATS subject token");
}

export function streamSubject(runId: string): string {
  assertSafeSubjectToken(runId);
  return `${DECOPILOT_STREAM_SUBJECT_PREFIX}.${runId}`;
}

export function buildChunkMsgId(input: {
  runId: string;
  fenceToken: string;
  seq: number;
  fragmentIndex?: number;
}): string {
  const base = `${input.runId}:${input.fenceToken}:${input.seq}`;
  return input.fragmentIndex === undefined
    ? base
    : `${base}:frag:${input.fragmentIndex}`;
}

export function buildDoneMsgId(input: {
  runId: string;
  fenceToken: string;
  finalSeq: number;
}): string {
  return `${input.runId}:${input.fenceToken}:done:${input.finalSeq}`;
}

export function buildCheckpointMsgId(input: {
  runId: string;
  fenceToken: string;
  headSeq: number;
}): string {
  return `${input.runId}:${input.fenceToken}:ckpt:${input.headSeq}`;
}

// --- Publisher ----------------------------------------------------------------

/** Observability injected by the app's live producer; omitted by tests. */
export interface PublisherHooks {
  /** Encode duration (ms) for each published ui-message-chunk. */
  onChunkEncoded?: (ms: number) => void;
  /** Fired once per published ui-message-chunk (count delta = 1). */
  onChunkPublished?: () => void;
}

export interface DirectNatsPublisher {
  publishLine(input: {
    runId: string;
    fenceToken: string;
    line: RelayLine;
  }): Promise<"published" | "terminal">;
  publishDone(input: {
    runId: string;
    fenceToken: string;
    finalSeq: number;
  }): Promise<void>;
  publishCheckpoint(input: {
    runId: string;
    fenceToken: string;
    headSeq: number;
  }): Promise<void>;
}

export function createDirectNatsPublisher(input: {
  js: Pick<JetStreamClient, "publish">;
  hooks?: PublisherHooks;
}): DirectNatsPublisher {
  const encoder = new TextEncoder();
  const hooks = input.hooks;
  return {
    async publishLine({ runId, fenceToken, line }) {
      if (line.event.type === "ui-message-chunk") {
        const t0 = performance.now();
        const bytes = encoder.encode(JSON.stringify({ p: line.event.chunk }));
        hooks?.onChunkEncoded?.(performance.now() - t0);
        hooks?.onChunkPublished?.();
        await input.js.publish(streamSubject(runId), bytes, {
          msgID: buildChunkMsgId({ runId, fenceToken, seq: line.seq }),
        });
        return "published";
      }
      if (line.event.type === "error") {
        const errorText = `${line.event.code}: ${line.event.message}`;
        await input.js.publish(
          streamSubject(runId),
          encoder.encode(JSON.stringify({ p: { type: "error", errorText } })),
          { msgID: buildChunkMsgId({ runId, fenceToken, seq: line.seq }) },
        );
        return "published";
      }
      return "terminal";
    },
    async publishDone({ runId, fenceToken, finalSeq }) {
      await input.js.publish(
        streamSubject(runId),
        encoder.encode(JSON.stringify({ done: true, finalSeq })),
        { msgID: buildDoneMsgId({ runId, fenceToken, finalSeq }) },
      );
    },
    async publishCheckpoint({ runId, fenceToken, headSeq }) {
      await input.js.publish(
        streamSubject(runId),
        encoder.encode(JSON.stringify({ checkpoint: true, headSeq })),
        { msgID: buildCheckpointMsgId({ runId, fenceToken, headSeq }) },
      );
    },
  };
}

export interface PublishRelayBodyResult {
  /** Highest wireSeq observed across ALL lines (incl. the terminal `done`
   *  line). The chunk-relay poster checks `lastSeq >= terminal seq`, so this
   *  must be the done line's seq, not the content count. */
  lastSeq: number;
}

async function* ndjsonValues(
  body: ReadableStream<Uint8Array> | string,
): AsyncGenerator<unknown> {
  if (typeof body === "string") {
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        yield JSON.parse(trimmed);
      } catch {
        // skip unparseable lines
      }
    }
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // keep the last (possibly incomplete) chunk in buffer
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          yield JSON.parse(trimmed);
        } catch {
          // skip unparseable lines
        }
      }
    }
    // flush remaining
    const flushed = buffer + decoder.decode();
    const trimmed = flushed.trim();
    if (trimmed !== "") {
      try {
        yield JSON.parse(trimmed);
      } catch {
        // skip
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function publishRelayBodyToNats(input: {
  body: ReadableStream<Uint8Array> | string;
  runId: string;
  fenceToken: string;
  publisher: DirectNatsPublisher;
  now?: () => number;
  checkpointDebounceMs?: number;
  /**
   * Reports the highest CONTENT seq durably published so far (each `publishLine`
   * awaits its JetStream PubAck before `finalSeq` advances, so everything up to
   * this value is durable). The relay uses it to drop the confirmed prefix from
   * the outbox. Throttled to the checkpoint cadence (+ a final report) so it
   * does not trigger a truncation per line.
   */
  onPublished?: (seq: number) => void;
}): Promise<PublishRelayBodyResult> {
  const now = input.now ?? Date.now;
  const debounceMs = input.checkpointDebounceMs ?? CHECKPOINT_DEBOUNCE_MS;
  let maxWireSeq = 0;
  let finalSeq = 0; // highest CONTENT seq (chunks + converted error), for done
  let reportedSeq = 0;
  let lastCheckpointAt = now(); // first checkpoint fires one debounce window in
  const reportPublished = (): void => {
    if (input.onPublished && finalSeq > reportedSeq) {
      reportedSeq = finalSeq;
      input.onPublished(finalSeq);
    }
  };
  for await (const value of ndjsonValues(input.body)) {
    const parsed = relayLineSchema.safeParse(value);
    if (!parsed.success) continue; // skip blank/garbage lines (heartbeats already skipped)
    const line = parsed.data;
    maxWireSeq = Math.max(maxWireSeq, line.seq);
    const result = await input.publisher.publishLine({
      runId: input.runId,
      fenceToken: input.fenceToken,
      line,
    });
    if (result === "published") {
      finalSeq = Math.max(finalSeq, line.seq);
      if (now() - lastCheckpointAt >= debounceMs) {
        lastCheckpointAt = now();
        await input.publisher.publishCheckpoint({
          runId: input.runId,
          fenceToken: input.fenceToken,
          headSeq: finalSeq,
        });
        reportPublished();
      }
    }
  }
  if (finalSeq > 0) {
    await input.publisher.publishDone({
      runId: input.runId,
      fenceToken: input.fenceToken,
      finalSeq,
    });
  }
  reportPublished();
  return { lastSeq: maxWireSeq };
}
