/**
 * Codec for the UIMessageChunk ⇄ JetStream wire format.
 *
 * This is the single source of truth for:
 *   - Wire message format (envelopes and subject scheme)
 *   - Message ID scheme (chunk, fragment, done)
 *   - Serialize: chunk → WireMessage[] (serializeChunk/serializeDone)
 *   - Decode: RawMsg → DecodedEvent (decodeMessage/decodeStream/reassembleFragments)
 *
 * Wire format (frozen byte-for-byte):
 *   chunk:         {"p":<UIMessageChunk>}
 *   fenced done:   {"done":true,"finalSeq":N}
 *   unfenced done: {"done":true}
 *
 * msgId scheme:
 *   chunk (no frag):  runId:fenceToken:seq
 *   chunk (fragment): runId:fenceToken:seq:frag:idx
 *   done:             runId:fenceToken:done:finalSeq
 */
import type { UIMessageChunk } from "ai";
import { MAX_PUBLISH_BYTES } from "./offload-messages";

// --- Subject + msgId scheme --------------------------------------------------

/** Prefix for decopilot stream subjects (no trailing dot). */
export const DECOPILOT_STREAM_SUBJECT_PREFIX = "decopilot.stream";

/** Header name carrying the fragment index (0-based) within a fragmented chunk. */
export const FRAG_INDEX_HEADER = "Dp-Frag-Idx";

/** Header name carrying the total fragment count within a fragmented chunk. */
export const FRAG_TOTAL_HEADER = "Dp-Frag-Total";

/** Hard drop ceiling for a single encoded stream chunk (32 MiB). */
export const MAX_CHUNKED_BYTES = 32 * 1024 * 1024;

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

// --- Parse helpers (moved from projector-stream-messages.ts) -----------------

export type ParsedRunStreamMsgId =
  | {
      kind: "chunk";
      runId: string;
      fenceToken: string;
      seq: number;
      fragmentIndex: number | null;
    }
  | {
      kind: "done";
      runId: string;
      fenceToken: string;
      finalSeq: number;
    };

function positiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function nonnegativeInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function parseRunStreamMsgId(
  msgId: string | undefined,
): ParsedRunStreamMsgId | null {
  if (!msgId) return null;
  const parts = msgId.split(":");
  const [runId, fenceToken, third, fourth, fifth] = parts;
  if (!runId || !fenceToken || !third) return null;
  if (third === "done") {
    const finalSeq = positiveInt(fourth);
    return parts.length === 4 && finalSeq !== null
      ? { kind: "done", runId, fenceToken, finalSeq }
      : null;
  }
  if (third === "ckpt") {
    // Leftover checkpoint markers from in-flight runs must parse to null so
    // they are not misclassified. Checkpoint publication was removed; this
    // branch exists solely as a transition-safety guard.
    return null;
  }
  const seq = positiveInt(third);
  if (seq === null) return null;
  if (parts.length === 3) {
    return { kind: "chunk", runId, fenceToken, seq, fragmentIndex: null };
  }
  if (parts.length === 5 && fourth === "frag") {
    const fragmentIndex = nonnegativeInt(fifth);
    return fragmentIndex === null
      ? null
      : { kind: "chunk", runId, fenceToken, seq, fragmentIndex };
  }
  return null;
}

// --- Serialize ---------------------------------------------------------------

export interface WireMessage {
  subject: string;
  data: Uint8Array;
  headers?: Record<string, string>;
  msgId?: string;
}

const encoder = new TextEncoder();

/**
 * Encode one UI chunk as `{p:chunk}` → 1+ wire messages.
 * - Fragments over MAX_PUBLISH_BYTES; each fragment gets FRAG_INDEX/TOTAL headers
 *   and a per-fragment msgId (`:frag:N` suffix).
 * - Returns [] (caller should warn) for payloads over MAX_CHUNKED_BYTES.
 * - `dedup` present ⇒ each message carries its canonical Nats-Msg-Id.
 */
export function serializeChunk(
  chunk: UIMessageChunk | unknown,
  opts: { runId: string; dedup?: { fenceToken: string; seq: number } },
): WireMessage[] {
  const subject = streamSubject(opts.runId);
  const bytes = encoder.encode(JSON.stringify({ p: chunk }));
  if (bytes.length > MAX_CHUNKED_BYTES) return [];
  if (bytes.length <= MAX_PUBLISH_BYTES) {
    return [
      {
        subject,
        data: bytes,
        msgId: opts.dedup
          ? buildChunkMsgId({ runId: opts.runId, ...opts.dedup })
          : undefined,
      },
    ];
  }
  const total = Math.ceil(bytes.length / MAX_PUBLISH_BYTES);
  const out: WireMessage[] = [];
  for (let i = 0; i < total; i++) {
    out.push({
      subject,
      data: bytes.slice(i * MAX_PUBLISH_BYTES, (i + 1) * MAX_PUBLISH_BYTES),
      headers: {
        [FRAG_INDEX_HEADER]: String(i),
        [FRAG_TOTAL_HEADER]: String(total),
      },
      msgId: opts.dedup
        ? buildChunkMsgId({
            runId: opts.runId,
            ...opts.dedup,
            fragmentIndex: i,
          })
        : undefined,
    });
  }
  return out;
}

/** Serialize a fenced done marker — carries `finalSeq` and a done msgId. */
export function serializeDone(ref: {
  runId: string;
  fenceToken: string;
  finalSeq: number;
}): WireMessage {
  return {
    subject: streamSubject(ref.runId),
    data: encoder.encode(
      JSON.stringify({ done: true, finalSeq: ref.finalSeq }),
    ),
    msgId: buildDoneMsgId(ref),
  };
}

/** Serialize an unfenced done marker — bare `{done:true}`, no msgId. */
export function serializeUnfencedDone(runId: string): WireMessage {
  return {
    subject: streamSubject(runId),
    data: encoder.encode(JSON.stringify({ done: true })),
  };
}

// --- Decode ------------------------------------------------------------------

export interface RawMsg {
  subject: string;
  data: Uint8Array;
  headers?: { get(name: string): string | undefined };
}

export type DecodedEvent =
  | {
      kind: "chunk";
      seq: number | null;
      runId: string | null;
      fenceToken: string | null;
      chunk: UIMessageChunk;
    }
  | {
      kind: "done";
      runId: string | null;
      fenceToken: string | null;
      envelopeFinalSeq: number | null;
      msgIdFinalSeq: number | null;
    };

export function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, p) => sum + (p?.length ?? 0), 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    if (!part) continue;
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function reassembleFragments(): TransformStream<RawMsg, RawMsg> {
  let frag: { total: number; received: number; parts: Uint8Array[] } | null =
    null;
  return new TransformStream<RawMsg, RawMsg>({
    transform(msg, controller) {
      const totalStr = msg.headers?.get(FRAG_TOTAL_HEADER);
      if (!totalStr) {
        controller.enqueue(msg); // not a fragment
        return;
      }
      const total = Number(totalStr);
      const index = Number(msg.headers?.get(FRAG_INDEX_HEADER) ?? "0");
      if (index === 0) {
        frag = { total, received: 0, parts: new Array(total) };
      } else if (!frag || frag.total !== total) {
        return; // stray fragment — no matching in-flight set
      }
      if (!frag.parts[index]) frag.received++;
      frag.parts[index] = msg.data;
      if (frag.received < frag.total) return; // need more
      const merged = concat(frag.parts);
      frag = null;
      controller.enqueue({
        subject: msg.subject,
        data: merged,
        headers: msg.headers,
      });
    },
  });
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

const decoder = new TextDecoder();

/**
 * Decode a single raw NATS message into a DecodedEvent, or null if it should
 * be skipped (malformed JSON, foreign payload shape, etc.).
 * This is the per-message core of `decodeStream()`'s transform.
 */
export function decodeMessage(msg: RawMsg): DecodedEvent | null {
  const parsed = parseRunStreamMsgId(
    msg.headers?.get("Nats-Msg-Id") || undefined,
  );
  let payload: unknown;
  try {
    payload = JSON.parse(decoder.decode(msg.data));
  } catch {
    return null; // skip malformed
  }
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;

  if (record.done === true) {
    return {
      kind: "done",
      runId: parsed?.kind === "done" ? parsed.runId : null,
      fenceToken: parsed?.kind === "done" ? parsed.fenceToken : null,
      envelopeFinalSeq: isPositiveInt(record.finalSeq) ? record.finalSeq : null,
      msgIdFinalSeq: parsed?.kind === "done" ? parsed.finalSeq : null,
    };
  }
  if ("p" in record) {
    return {
      kind: "chunk",
      seq: parsed?.kind === "chunk" ? parsed.seq : null,
      runId: parsed?.kind === "chunk" ? parsed.runId : null,
      fenceToken: parsed?.kind === "chunk" ? parsed.fenceToken : null,
      chunk: record.p as UIMessageChunk,
    };
  }
  // anything else (foreign shape) → null
  return null;
}

/**
 * Transform stream that decodes raw NATS messages into DecodedEvents,
 * dropping nulls (malformed / foreign messages).
 */
export function decodeStream(): TransformStream<RawMsg, DecodedEvent> {
  return new TransformStream<RawMsg, DecodedEvent>({
    transform(msg, controller) {
      const ev = decodeMessage(msg);
      if (ev) controller.enqueue(ev);
    },
  });
}
