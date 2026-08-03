/**
 * Direct-NATS relay publisher — the producer half of the chunk-relay protocol
 * (spec: "Transport Convergence", protocol v2). A desktop daemon publishes each
 * seq-numbered RelayLine straight to the JetStream subject
 * `decopilot.stream.<runId>`; the always-on durable projector consumes it.
 *
 * Wire format (subject + msgId scheme + envelope shapes) is now owned by
 * `@decocms/shared/harness/run-stream-codec` — the single source of truth shared by
 *   - the app's live producer (apps/api/src/link-daemon/direct-nats-publisher.ts,
 *     a thin adapter that injects OpenTelemetry metrics via `hooks`), and
 *   - the e2e "fake daemon" relay (packages/e2e/fixtures/relay-nats.ts).
 *
 * It is metrics-agnostic on purpose — observability is injected via optional
 * `hooks` so a test (no OTel meter wired) can drive it directly.
 */
import type { JetStreamClient } from "@nats-io/jetstream";
import { headers as natsHeaders, type MsgHdrs } from "@nats-io/nats-core";
import { relayLineSchema, type RelayLine } from "./relay";
import {
  serializeChunk,
  serializeDone,
} from "@decocms/shared/harness/run-stream-codec";

/** Debounce between incremental outbox-truncation reports. Rolling truncation
 *  keeps the durable outbox from accumulating the entire run in memory; without
 *  mid-stream reports the cap becomes a hard per-run limit instead of a backstop. */
const OUTBOX_REPORT_DEBOUNCE_MS = 3000;

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
}

function toMsgHdrs(rec: Record<string, string>): MsgHdrs {
  const hdrs = natsHeaders();
  for (const [k, v] of Object.entries(rec)) {
    hdrs.set(k, v);
  }
  return hdrs;
}

export function createDirectNatsPublisher(input: {
  js: Pick<JetStreamClient, "publish">;
  hooks?: PublisherHooks;
}): DirectNatsPublisher {
  const hooks = input.hooks;
  return {
    async publishLine({ runId, fenceToken, line }) {
      if (line.event.type === "ui-message-chunk") {
        const t0 = performance.now();
        const msgs = serializeChunk(line.event.chunk, {
          runId,
          dedup: { fenceToken, seq: line.seq },
        });
        hooks?.onChunkEncoded?.(performance.now() - t0);
        if (msgs.length === 0) {
          console.warn(
            `[relay-publisher] dropping oversized ui-message-chunk for run ${runId}: exceeds MAX_CHUNKED_BYTES cap`,
          );
          return "published";
        }
        hooks?.onChunkPublished?.();
        for (const m of msgs) {
          await input.js.publish(m.subject, m.data, {
            ...(m.headers ? { headers: toMsgHdrs(m.headers) } : {}),
            ...(m.msgId ? { msgID: m.msgId } : {}),
          });
        }
        return "published";
      }
      if (line.event.type === "error") {
        const errorText = `${line.event.code}: ${line.event.message}`;
        const msgs = serializeChunk(
          { type: "error", errorText },
          { runId, dedup: { fenceToken, seq: line.seq } },
        );
        if (msgs.length === 0) {
          console.warn(
            `[relay-publisher] dropping oversized error chunk for run ${runId}: exceeds MAX_CHUNKED_BYTES cap`,
          );
          return "published";
        }
        for (const m of msgs) {
          await input.js.publish(m.subject, m.data, {
            ...(m.headers ? { headers: toMsgHdrs(m.headers) } : {}),
            ...(m.msgId ? { msgID: m.msgId } : {}),
          });
        }
        return "published";
      }
      return "terminal";
    },
    async publishDone({ runId, fenceToken, finalSeq }) {
      const m = serializeDone({ runId, fenceToken, finalSeq });
      await input.js.publish(m.subject, m.data, { msgID: m.msgId });
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
  reportDebounceMs?: number;
  /**
   * Reports the highest CONTENT seq durably published so far (each `publishLine`
   * awaits its JetStream PubAck before `finalSeq` advances, so everything up to
   * this value is durable). The relay uses it to drop the confirmed prefix from
   * the outbox. Throttled to the report cadence (+ a final terminal report) so
   * it drives rolling truncation rather than triggering a truncation per line.
   */
  onPublished?: (seq: number) => void;
}): Promise<PublishRelayBodyResult> {
  const now = input.now ?? Date.now;
  const debounceMs = input.reportDebounceMs ?? OUTBOX_REPORT_DEBOUNCE_MS;
  let maxWireSeq = 0;
  let finalSeq = 0; // highest CONTENT seq (chunks + converted error), for done
  let reportedSeq = 0;
  let lastReportAt = now(); // first report fires one debounce window in
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
      if (now() - lastReportAt >= debounceMs) {
        lastReportAt = now();
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
