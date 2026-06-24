import type { UIMessageChunk } from "ai";
import { DeliverPolicy, type JetStreamClient } from "@nats-io/jetstream";
import {
  DECOPILOT_STREAM_NAME,
  isDoneEnvelope,
  parseRunStreamMsgId,
  runIdFromSubject,
  streamSubject,
} from "./projector-stream-messages";

const FRAG_INDEX_HEADER = "Dp-Frag-Idx";
const FRAG_TOTAL_HEADER = "Dp-Frag-Total";

export interface ProjectorRetainedMessage {
  subject: string;
  msgId?: string;
  data: Uint8Array;
  headers?: { get(name: string): string | undefined };
}

export type ReconstructResult =
  | { ok: true; chunks: UIMessageChunk[]; chunkCount: number }
  | { ok: false; error: string };

export type ReconstructRangeResult =
  | { ok: true; chunks: UIMessageChunk[]; lastContiguousSeq: number }
  | { ok: false; error: string };

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function decodePayload(data: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(data));
}

interface ChunkCollector {
  /** Decode one retained message into the running chunk map (idempotent). */
  push(message: ProjectorRetainedMessage): void;
  /** seq → decoded chunk for every seq ≤ `upTo` seen so far. */
  readonly chunks: Map<number, UIMessageChunk>;
  /** finalSeq from the `done` envelope once seen, else null. */
  readonly doneFinalSeq: number | null;
}

/**
 * Stateful, incremental version of the decode/reassemble loop. Feed it one
 * retained message at a time; it decodes each chunk ONCE on arrival and keeps
 * only the decoded `UIMessageChunk` (plus in-flight fragment parts), never the
 * raw message bytes.
 *
 * Streaming readers (`readProjectorRunLog` / `readProjectorRunRange`) use this
 * so they don't retain the whole run's raw payload AND don't `JSON.parse` the
 * entire log in one synchronous burst at `done` — that transient allocation
 * spike (large run payloads) is what OOMKilled the worker between metric
 * scrapes and stalled the event loop into the liveness probe. Spreading the
 * decode across arrivals flattens the peak; only the decoded chunks (the
 * projection's actual output) stay resident.
 */
function createChunkCollector(
  runId: string,
  fenceToken: string,
  upTo: number,
): ChunkCollector {
  const chunks = new Map<number, UIMessageChunk>();
  const fragments = new Map<number, { total: number; parts: Uint8Array[] }>();
  let doneFinalSeq: number | null = null;

  return {
    chunks,
    get doneFinalSeq() {
      return doneFinalSeq;
    },
    push(message) {
      if (runIdFromSubject(message.subject) !== runId) return;
      const parsed = parseRunStreamMsgId(message.msgId);
      if (
        !parsed ||
        parsed.runId !== runId ||
        parsed.fenceToken !== fenceToken
      ) {
        return;
      }

      if (parsed.kind === "done") {
        const payload = decodePayload(message.data);
        if (isDoneEnvelope(payload)) {
          doneFinalSeq = parsed.finalSeq;
        }
        return;
      }

      if (parsed.kind !== "chunk") return;

      if (parsed.seq > upTo) return;
      const total = Number(message.headers?.get(FRAG_TOTAL_HEADER) ?? "0");
      if (parsed.fragmentIndex !== null || total > 0) {
        const index =
          parsed.fragmentIndex ??
          Number(message.headers?.get(FRAG_INDEX_HEADER) ?? "0");
        const existing = fragments.get(parsed.seq) ?? {
          total,
          parts: new Array(total),
        };
        existing.parts[index] = message.data;
        fragments.set(parsed.seq, existing);
        if (existing.parts.filter(Boolean).length === existing.total) {
          const payload = decodePayload(concat(existing.parts));
          if (payload && typeof payload === "object" && "p" in payload) {
            chunks.set(parsed.seq, (payload as { p: UIMessageChunk }).p);
          }
          // Drop the raw fragment parts now that the chunk is decoded.
          fragments.delete(parsed.seq);
        }
        return;
      }

      const payload = decodePayload(message.data);
      if (payload && typeof payload === "object" && "p" in payload) {
        chunks.set(parsed.seq, (payload as { p: UIMessageChunk }).p);
      }
    },
  };
}

/**
 * Batch helper: decodes messages and reassembles fragments, returning a map
 * of seq → UIMessageChunk for all seqs up to `upTo`, plus the finalSeq from the
 * `done` envelope if one was seen. Thin wrapper over {@link createChunkCollector}
 * so the batch reconstruct paths and the streaming readers share one decoder.
 */
function collectChunks(
  messages: ProjectorRetainedMessage[],
  runId: string,
  fenceToken: string,
  upTo: number,
): {
  chunks: Map<number, UIMessageChunk>;
  doneFinalSeq: number | null;
} {
  const collector = createChunkCollector(runId, fenceToken, upTo);
  for (const message of messages) collector.push(message);
  return { chunks: collector.chunks, doneFinalSeq: collector.doneFinalSeq };
}

/** Order the contiguous seq 1..finalSeq run, requiring a matching `done`. */
function orderFullRun(
  chunks: Map<number, UIMessageChunk>,
  doneFinalSeq: number | null,
  finalSeq: number,
): ReconstructResult {
  // Only accept the `done` marker if its finalSeq matches exactly.
  if (doneFinalSeq !== finalSeq) return { ok: false, error: "missing done" };
  const out: UIMessageChunk[] = [];
  for (let seq = 1; seq <= finalSeq; seq++) {
    const chunk = chunks.get(seq);
    if (!chunk) return { ok: false, error: `missing seq ${seq}` };
    out.push(chunk);
  }
  return { ok: true, chunks: out, chunkCount: out.length };
}

/** Order the contiguous prefix fromSeq+1..toSeq, no `done` required. */
function orderRange(
  chunks: Map<number, UIMessageChunk>,
  fromSeq: number,
  toSeq: number,
): ReconstructRangeResult {
  const out: UIMessageChunk[] = [];
  let seq = fromSeq;
  for (let s = fromSeq + 1; s <= toSeq; s++) {
    const c = chunks.get(s);
    if (!c) break; // gap: stop at contiguous prefix (no error, no done needed)
    out.push(c);
    seq = s;
  }
  return { ok: true, chunks: out, lastContiguousSeq: seq };
}

export function reconstructProjectorRun(input: {
  runId: string;
  fenceToken: string;
  finalSeq: number;
  messages: ProjectorRetainedMessage[];
}): ReconstructResult {
  const { chunks, doneFinalSeq } = collectChunks(
    input.messages,
    input.runId,
    input.fenceToken,
    input.finalSeq,
  );
  return orderFullRun(chunks, doneFinalSeq, input.finalSeq);
}

export function reconstructProjectorRunRange(input: {
  runId: string;
  fenceToken: string;
  fromSeq: number;
  toSeq: number;
  messages: ProjectorRetainedMessage[];
}): ReconstructRangeResult {
  const { chunks } = collectChunks(
    input.messages,
    input.runId,
    input.fenceToken,
    input.toSeq,
  );
  return orderRange(chunks, input.fromSeq, input.toSeq);
}

export async function readProjectorRunRange(input: {
  js: JetStreamClient;
  runId: string;
  fenceToken: string;
  fromSeq: number;
  toSeq: number;
  idleTimeoutMs?: number;
}): Promise<ReconstructRangeResult> {
  const consumer = await input.js.consumers.get(DECOPILOT_STREAM_NAME, {
    filter_subjects: streamSubject(input.runId),
    deliver_policy: DeliverPolicy.All,
  });
  const sub = await consumer.consume();
  // Decode incrementally and drop each raw message; retain only decoded chunks.
  const collector = createChunkCollector(
    input.runId,
    input.fenceToken,
    input.toSeq,
  );
  const idleTimeoutMs = input.idleTimeoutMs ?? 5000;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const resetIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => sub.stop(), idleTimeoutMs);
    idle.unref?.();
  };
  try {
    resetIdle();
    for await (const m of sub) {
      resetIdle();
      const msgId = m.headers?.get("Nats-Msg-Id") || undefined;
      collector.push({
        subject: m.subject,
        data: m.data,
        msgId,
        headers: m.headers,
      });
      const parsed = parseRunStreamMsgId(msgId);
      if (parsed && "seq" in parsed && parsed.seq >= input.toSeq) {
        sub.stop();
        break;
      }
    }
  } finally {
    if (idle) clearTimeout(idle);
  }
  return orderRange(collector.chunks, input.fromSeq, input.toSeq);
}

export async function readProjectorRunLog(input: {
  js: JetStreamClient;
  runId: string;
  fenceToken: string;
  finalSeq: number;
  idleTimeoutMs?: number;
}): Promise<ReconstructResult> {
  // v3 ordered (ephemeral, no-ack) consumer over the run's subject — the
  // replacement for v2's removed `js.subscribe(..., {ordered:true})`.
  const consumer = await input.js.consumers.get(DECOPILOT_STREAM_NAME, {
    filter_subjects: streamSubject(input.runId),
    deliver_policy: DeliverPolicy.All,
  });
  const sub = await consumer.consume();
  // Decode each message ONCE on arrival into the collector and let the raw
  // bytes go (never retain the whole run's payload). The fold that builds the
  // ordered output runs only once `done` arrives — O(N), on already-decoded
  // chunks, no JSON.parse burst. This is the worker hot path: the old retain-
  // all + parse-everything-at-`done` shape spiked allocation (OOMKill between
  // metric scrapes) and stalled the event loop into the liveness probe.
  const collector = createChunkCollector(
    input.runId,
    input.fenceToken,
    input.finalSeq,
  );
  const idleTimeoutMs = input.idleTimeoutMs ?? 1000;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const resetIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      timedOut = true;
      sub.stop();
    }, idleTimeoutMs);
    idle.unref?.();
  };

  try {
    resetIdle();
    for await (const m of sub) {
      resetIdle();
      const msgId = m.headers?.get("Nats-Msg-Id") || undefined;
      collector.push({
        subject: m.subject,
        data: m.data,
        msgId,
        headers: m.headers,
      });
      // The ordered fold can only succeed once the `done` envelope (final
      // message) has arrived. Gate it on the cheap msgId parse so we order
      // once, at `done`, instead of on every message.
      const parsed = parseRunStreamMsgId(msgId);
      if (parsed?.kind !== "done" || parsed.finalSeq !== input.finalSeq)
        continue;
      const current = orderFullRun(
        collector.chunks,
        collector.doneFinalSeq,
        input.finalSeq,
      );
      if (current.ok) {
        sub.stop();
        return current;
      }
    }
  } finally {
    if (idle) clearTimeout(idle);
  }

  return timedOut
    ? orderFullRun(collector.chunks, collector.doneFinalSeq, input.finalSeq)
    : { ok: false, error: "reader stopped before done" };
}
