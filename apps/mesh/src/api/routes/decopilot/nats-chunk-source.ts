// apps/mesh/src/api/routes/decopilot/nats-chunk-source.ts
import type { UIMessageChunk } from "ai";
import { sleep } from "@decocms/std";
import type { DecodedEvent, RawMsg } from "@decocms/harness/run-stream-codec";

export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;

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
          await reader.cancel();
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
            await reader.cancel();
            release();
            controller.error(new Error(`missing seq ${lastSeq + 1}`));
            return;
          }
          await reader.cancel();
          release();
          controller.close();
          return;
        }
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
 * fires once on cancel.
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
