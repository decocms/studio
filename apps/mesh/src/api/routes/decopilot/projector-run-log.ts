import type { UIMessageChunk } from "ai";
import { DeliverPolicy, type JetStreamClient } from "@nats-io/jetstream";
import {
  DECOPILOT_STREAM_NAME,
  isDoneEnvelope,
  parseRunStreamMsgId,
  runIdFromSubject,
  streamSubject,
} from "./projector-stream-messages";
import { FRAG_INDEX_HEADER, FRAG_TOTAL_HEADER } from "./nats-chunk-source";

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

/**
 * Shared helper: decodes messages and reassembles fragments, returning a map
 * of seq → UIMessageChunk for all seqs up to `upTo`. Also returns the
 * finalSeq from the `done` envelope if one was seen (null otherwise).
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
  const chunks = new Map<number, UIMessageChunk>();
  const fragments = new Map<number, { total: number; parts: Uint8Array[] }>();
  let doneFinalSeq: number | null = null;

  for (const message of messages) {
    if (runIdFromSubject(message.subject) !== runId) continue;
    const parsed = parseRunStreamMsgId(message.msgId);
    if (!parsed || parsed.runId !== runId || parsed.fenceToken !== fenceToken) {
      continue;
    }

    if (parsed.kind === "done") {
      const payload = decodePayload(message.data);
      if (isDoneEnvelope(payload)) {
        doneFinalSeq = parsed.finalSeq;
      }
      continue;
    }

    if (parsed.kind !== "chunk") continue;

    if (parsed.seq > upTo) continue;
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
      }
      continue;
    }

    const payload = decodePayload(message.data);
    if (payload && typeof payload === "object" && "p" in payload) {
      chunks.set(parsed.seq, (payload as { p: UIMessageChunk }).p);
    }
  }

  return { chunks, doneFinalSeq };
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

  // Only accept the `done` marker if its finalSeq matches exactly.
  if (doneFinalSeq !== input.finalSeq)
    return { ok: false, error: "missing done" };
  const out: UIMessageChunk[] = [];
  for (let seq = 1; seq <= input.finalSeq; seq++) {
    const chunk = chunks.get(seq);
    if (!chunk) return { ok: false, error: `missing seq ${seq}` };
    out.push(chunk);
  }
  return { ok: true, chunks: out, chunkCount: out.length };
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
  const out: UIMessageChunk[] = [];
  let seq = input.fromSeq;
  for (let s = input.fromSeq + 1; s <= input.toSeq; s++) {
    const c = chunks.get(s);
    if (!c) break; // gap: stop at contiguous prefix (no error, no done needed)
    out.push(c);
    seq = s;
  }
  return { ok: true, chunks: out, lastContiguousSeq: seq };
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
  const messages: ProjectorRetainedMessage[] = [];
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
      messages.push({
        subject: m.subject,
        data: m.data,
        msgId: m.headers?.get("Nats-Msg-Id") || undefined,
        headers: m.headers,
      });
      const parsed = parseRunStreamMsgId(
        m.headers?.get("Nats-Msg-Id") || undefined,
      );
      if (parsed && "seq" in parsed && parsed.seq >= input.toSeq) {
        sub.stop();
        break;
      }
    }
  } finally {
    if (idle) clearTimeout(idle);
  }
  return reconstructProjectorRunRange({ ...input, messages });
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
  const messages: ProjectorRetainedMessage[] = [];
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
      messages.push({
        subject: m.subject,
        data: m.data,
        msgId,
        headers: m.headers,
      });
      // reconstructProjectorRun re-parses the WHOLE accumulated log; it can only
      // succeed once the `done` envelope (final message) has arrived — every
      // earlier call returns "missing done". Folding on every message is O(N²)
      // JSON.parse on the event loop and stalls it for tens of seconds on long
      // runs. Gate the fold on the cheap msgId parse → fold once, O(N).
      const parsed = parseRunStreamMsgId(msgId);
      if (parsed?.kind !== "done" || parsed.finalSeq !== input.finalSeq)
        continue;
      const current = reconstructProjectorRun({
        runId: input.runId,
        fenceToken: input.fenceToken,
        finalSeq: input.finalSeq,
        messages,
      });
      if (current.ok) {
        sub.stop();
        return current;
      }
    }
  } finally {
    if (idle) clearTimeout(idle);
  }

  return timedOut
    ? reconstructProjectorRun({
        runId: input.runId,
        fenceToken: input.fenceToken,
        finalSeq: input.finalSeq,
        messages,
      })
    : { ok: false, error: "reader stopped before done" };
}
