// apps/mesh/src/api/routes/decopilot/nats-chunk-source.ts
import type { UIMessageChunk } from "ai";
import { sleep } from "@decocms/std";
import { parseRunStreamMsgId } from "./projector-stream-messages";

export const FRAG_INDEX_HEADER = "Dp-Frag-Idx";
export const FRAG_TOTAL_HEADER = "Dp-Frag-Total";
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;

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
    }
  | {
      kind: "checkpoint";
      runId: string | null;
      fenceToken: string | null;
      headSeq: number;
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

export function unwrapPayload(): TransformStream<RawMsg, DecodedEvent> {
  const decoder = new TextDecoder();
  return new TransformStream<RawMsg, DecodedEvent>({
    transform(msg, controller) {
      const parsed = parseRunStreamMsgId(
        msg.headers?.get("Nats-Msg-Id") || undefined,
      );
      let payload: unknown;
      try {
        payload = JSON.parse(decoder.decode(msg.data));
      } catch {
        return; // skip malformed
      }
      if (!payload || typeof payload !== "object") return;
      const record = payload as Record<string, unknown>;

      if (record.done === true) {
        controller.enqueue({
          kind: "done",
          runId: parsed?.kind === "done" ? parsed.runId : null,
          fenceToken: parsed?.kind === "done" ? parsed.fenceToken : null,
          envelopeFinalSeq: isPositiveInt(record.finalSeq)
            ? record.finalSeq
            : null,
          msgIdFinalSeq: parsed?.kind === "done" ? parsed.finalSeq : null,
        });
        return;
      }
      if (record.checkpoint === true && parsed?.kind === "checkpoint") {
        controller.enqueue({
          kind: "checkpoint",
          runId: parsed.runId,
          fenceToken: parsed.fenceToken,
          headSeq: parsed.headSeq,
        });
        return;
      }
      if ("p" in record) {
        controller.enqueue({
          kind: "chunk",
          seq: parsed?.kind === "chunk" ? parsed.seq : null,
          runId: parsed?.kind === "chunk" ? parsed.runId : null,
          fenceToken: parsed?.kind === "chunk" ? parsed.fenceToken : null,
          chunk: record.p as UIMessageChunk,
        });
        return;
      }
      // anything else (checkpoint without msgId, foreign shape) → skip
    },
  });
}

export function fenceFilter(
  runId: string,
  fenceToken: string,
): TransformStream<DecodedEvent, DecodedEvent> {
  return new TransformStream<DecodedEvent, DecodedEvent>({
    transform(ev, controller) {
      if (ev.runId !== runId || ev.fenceToken !== fenceToken) return; // drop
      controller.enqueue(ev);
    },
  });
}

export function assertContiguousAndDedup(): TransformStream<
  DecodedEvent,
  DecodedEvent
> {
  let nextSeq = 1;
  return new TransformStream<DecodedEvent, DecodedEvent>({
    transform(ev, controller) {
      if (ev.kind === "done") {
        controller.enqueue(ev);
        return;
      }
      if (ev.kind === "checkpoint") return; // projector ignores checkpoints in the terminal fold
      if (ev.seq === null) {
        controller.error(new Error("projector chunk missing seq"));
        return;
      }
      if (ev.seq < nextSeq) return; // dedup replay (resend past the dedup window)
      if (ev.seq > nextSeq) {
        controller.error(new Error(`missing seq ${nextSeq}`));
        return;
      }
      nextSeq++;
      controller.enqueue(ev);
    },
  });
}

export function projectorChunkStream(
  events: ReadableStream<DecodedEvent>,
): ReadableStream<UIMessageChunk> {
  const reader = events.getReader();
  let released = false;
  let lastSeq = 0;
  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.error(new Error("reader stopped before done"));
          return;
        }
        const ev = value;
        if (ev.kind === "done") {
          const valid =
            ev.envelopeFinalSeq != null &&
            ev.envelopeFinalSeq === ev.msgIdFinalSeq;
          if (!valid) continue; // ignore an invalid/partial done; keep reading
          if (ev.envelopeFinalSeq !== lastSeq) {
            release();
            controller.error(new Error(`missing seq ${lastSeq + 1}`));
            return;
          }
          await reader.cancel();
          release();
          controller.close();
          return;
        }
        if (ev.kind === "checkpoint") continue;
        lastSeq = ev.seq ?? lastSeq;
        controller.enqueue(ev.chunk);
        if (ev.chunk.type === "finish") {
          await reader.cancel();
          release();
          controller.close();
        }
        return;
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      release();
    },
  });
}

function iteratorFor<T>(
  source: AsyncIterable<T> | Iterable<T>,
): AsyncIterator<T> {
  if (Symbol.asyncIterator in source) return source[Symbol.asyncIterator]();
  const iter = (source as Iterable<T>)[Symbol.iterator]();
  return {
    next: async () => iter.next(),
    return: async (value?: unknown) =>
      iter.return
        ? iter.return(value as never)
        : ({ done: true, value: value as T } as IteratorResult<T>),
  };
}

/**
 * Shared NATS source: turns an iterable of raw run-stream messages into a
 * pull-based `ReadableStream<RawMsg>`. `idleTimeoutMs` (projector only) errors
 * the stream when a pull produces no message within the window; omit it for the
 * live tail, which stays open across silent gaps. `onCancel` (e.g. `sub.stop`)
 * fires once on cancel or natural source exhaustion.
 */
export function natsChunkSource(opts: {
  messages: AsyncIterable<RawMsg> | Iterable<RawMsg>;
  idleTimeoutMs?: number;
  onCancel?: () => void;
}): ReadableStream<RawMsg> {
  const iterator = iteratorFor(opts.messages);
  const idleTimeoutMs = opts.idleTimeoutMs;
  let cancelled = false;
  const doCancel = (reason?: unknown) => {
    if (cancelled) return;
    cancelled = true;
    iterator.return?.(reason).catch(() => {});
    opts.onCancel?.();
  };
  return new ReadableStream<RawMsg>({
    async pull(controller) {
      if (idleTimeoutMs === undefined) {
        const { done, value } = await iterator.next();
        if (done) {
          doCancel();
          controller.close();
          return;
        }
        controller.enqueue(value);
        return;
      }
      const idleCtl = new AbortController();
      const next = iterator.next().then((r) => {
        idleCtl.abort();
        return r;
      });
      const idle = sleep(idleTimeoutMs, { signal: idleCtl.signal })
        .then(() => "idle" as const)
        .catch(() => "cancelled" as const);
      const result = await Promise.race([next, idle]);
      if (result === "idle") {
        controller.error(
          new Error("producer produced no output before timeout"),
        );
        return;
      }
      if (result === "cancelled") return; // idle lost the race; loop again on next pull
      if (result.done) {
        doCancel();
        controller.close();
        return;
      }
      controller.enqueue(result.value);
    },
    async cancel(reason) {
      doCancel(reason);
    },
  });
}
