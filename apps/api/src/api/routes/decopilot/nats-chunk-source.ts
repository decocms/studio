// apps/api/src/api/routes/decopilot/nats-chunk-source.ts
import type { UIMessageChunk } from "ai";
import { sleep } from "@decocms/shared/std";
import type { DecodedEvent, RawMsg } from "@decocms/harness/run-stream-codec";

/**
 * Thrown by `natsChunkSource` when a pull produces no message within
 * `idleTimeoutMs` — the subject went silent. Distinguishable via `instanceof`
 * from any other error a downstream stage (decode/fence/dedup, persistence)
 * might throw, so a caller can tell a TRUE liveness breach (nothing published
 * at all) apart from a genuine projection failure (unified-control-plane T4:
 * see `runProjectorWorkflowBody`'s catch in `projector-workflow.ts`, which
 * maps this to `markRunFailed(kind: "liveness")` instead of `"projection"`).
 * Carries the window that elapsed so the caller can render it (e.g. "no
 * stream events for 10m") without threading the value through twice.
 */
export class StreamIdleTimeoutError extends Error {
  constructor(public readonly idleTimeoutMs: number) {
    super("producer produced no output before timeout");
    this.name = "StreamIdleTimeoutError";
  }
}

/**
 * Thrown when the fenced chunk sequence has a hole: the subject no longer
 * retains a chunk the projection needs (retention discard — the stream's 4GB
 * `DiscardPolicy.Old` / 24h age caps — or a purge racing a redelivery).
 * Distinguishable via `instanceof` from a genuine projection bug because the
 * caller must treat it differently: redelivery can NEVER succeed (the data is
 * gone), so the projector maps this to a clean terminal failure instead of
 * rethrowing into DBOS step retries that are pure burn (see
 * `runProjectorWorkflowBody`'s catch in `projector-workflow.ts`).
 * `gotSeq === null` means the fenced done arrived before `expectedSeq` was
 * ever delivered (tail truncation under the done's `finalSeq`).
 */
export class StreamGapError extends Error {
  constructor(
    public readonly expectedSeq: number,
    public readonly gotSeq: number | null,
  ) {
    super(
      gotSeq === null
        ? `missing seq ${expectedSeq} (stream ended at the fenced done)`
        : `missing seq ${expectedSeq} (next delivered is ${gotSeq})`,
    );
    this.name = "StreamGapError";
  }
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
      if (ev.seq === null) {
        controller.error(new Error("projector chunk missing seq"));
        return;
      }
      if (ev.seq < nextSeq) return; // dedup replay (resend past the dedup window)
      if (ev.seq > nextSeq) {
        controller.error(new StreamGapError(nextSeq, ev.seq));
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
            controller.error(new StreamGapError(lastSeq + 1, null));
            return;
          }
          await reader.cancel();
          release();
          controller.close();
          return;
        }
        lastSeq = ev.seq ?? lastSeq;
        controller.enqueue(ev.chunk);
        // Terminate only on the fenced `done` marker, never on the assistant
        // `finish` chunk. Background title generation emits its transient
        // `data-title-result` chunk AFTER `finish` on fast runs; the producer
        // gives it a seq and the fenced done's `finalSeq` covers it. Closing at
        // `finish` raced (and dropped) that title, leaving the thread on "New
        // chat". The idle-timeout (StreamIdleTimeoutError) is the backstop for a
        // producer that dies before publishing its done.
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
 * the stream with `StreamIdleTimeoutError` when a pull produces no message
 * within the window; omit it for the live tail, which stays open across
 * silent gaps. `onCancel` (e.g. `sub.stop`) fires once on cancel.
 *
 * The idle window is per-PULL, not a single deadline for the whole stream:
 * each `pull()` call below races a fresh `iterator.next()` against a fresh
 * `sleep(idleTimeoutMs)`, and any message — a UI chunk, a status chunk, a
 * future `data-liveness` heartbeat, literally anything the ReadableStream
 * machinery hands back from `iterator.next()` — resolves that race and the
 * NEXT `pull()` starts a brand-new window. So "no events of any kind for
 * idleTimeoutMs" is exactly what trips this, not "no events since stream
 * start" (unified-control-plane T4).
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
        controller.error(new StreamIdleTimeoutError(idleTimeoutMs));
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
