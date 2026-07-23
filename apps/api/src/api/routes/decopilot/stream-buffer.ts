/**
 * Stream Buffer Interface
 *
 * Abstraction for treating a NATS JetStream subject as the single source
 * of truth for a run's UI stream. The producer (`dispatchRunAndWait`) pumps
 * chunks into JetStream via `pump()`; every `/stream` HTTP response reads
 * from JetStream via `createTailStream()`. The producer's lifetime is bound
 * to the run registry, not to any HTTP consumer, so a proxy/idle/tab-close
 * on the consumer side never stalls or drops chunks.
 */

/**
 * StreamBuffer is the persistent fan-out point for a run's UI stream.
 * Chunks pumped via `pump()` are visible to every `createTailStream()`
 * consumer, including ones that subscribe after chunks were published.
 */
export interface StreamBuffer {
  /** Initialize the buffer (e.g., ensure JetStream stream exists). */
  init(): Promise<void>;

  /**
   * Drains `stream` into the per-task subject, publishing each chunk as a
   * JetStream message. When `stream` ends (or `registrySignal` aborts),
   * publishes a `{done: true}` sentinel so tail consumers can close — even on
   * a mid-stream failure, so a live `/stream` tail always sees SOME done
   * marker instead of hanging.
   *
   * The pump is the sole consumer of `stream`; do not also `pipeThrough` or
   * `tee` it for the HTTP response. Tail consumers read from JetStream via
   * `createTailStream`.
   *
   * Returns a promise: the caller need not await it to let draining start
   * (it begins synchronously, same as the old fire-and-forget contract), but
   * AWAITING it surfaces a mid-stream `stream` error as a rejection — the
   * `{done}` sentinel above is published regardless, so a rejection here
   * means "the tail closed, but the run did not finish cleanly," not "the
   * tail never closed." `dispatchRunAndWait` awaits this after its own
   * tail-wait loop so a mid-stream ingest failure (with healthy JetStream)
   * propagates instead of looking like a clean completion.
   *
   * `orgId` is optional but recommended — it tags the `decopilot.stream.publish_errors`
   * OTEL counter so per-org alerting is possible.
   */
  pump(
    stream: ReadableStream,
    taskId: string,
    registrySignal: AbortSignal,
    orgId?: string,
  ): Promise<void>;

  /**
   * Publish ONE raw chunk to the per-task subject and AWAIT the publish ack.
   * Unlike `pump` (fire-and-forget over a whole stream), this is the durable
   * commit point for the publish-then-consume ingest (spec §5.3): the caller
   * advances its ack cursor only after this resolves `true`. Returns `false`
   * when JetStream is unavailable (caller must not advance the cursor).
   *
   * `dedup` sets the JetStream `Nats-Msg-Id` for time-based dedup: a
   * seq-keyed id (`${runId}:${fenceToken}:${seq}`) lets an at-least-once
   * producer (outbox retry) re-publish the same chunk without double-writing.
   */
  publishRawChunk(
    taskId: string,
    chunk: unknown,
    dedup?: { fenceToken: string; seq: number },
  ): Promise<boolean>;

  /**
   * Publish the authoritative terminal sentinel for one run and await the
   * JetStream ack. The projector scheduler starts DBOS projection from this
   * marker, so callers must not treat a run as handed off until this resolves
   * true.
   */
  publishDone(
    taskId: string,
    fenceToken: string,
    finalSeq: number,
  ): Promise<boolean>;

  /**
   * Subscribe to the per-task subject and stream chunks as a ReadableStream.
   * Returns null when JetStream is unavailable.
   *
   * The stream stays open across runs — the producer's `{done: true}`
   * sentinel is swallowed server-side, and clients detect run boundaries
   * from the AI-SDK `{type: "finish"}` chunk in the data stream itself.
   * One open connection per (tab, thread) covers every subsequent run.
   *
   * Options:
   * - `deliverPolicy` (default `"all"`): `"all"` replays from the start of
   *   the subject (catch up to in-flight runs); `"new"` only delivers
   *   chunks published after the subscription is established (use when the
   *   thread is idle and we don't want to replay any stale tail of a
   *   recently-completed run).
   * - `closeOnDone` (default `false`): when true, close the stream as soon
   *   as a `{done: true}` sentinel arrives. Use for callers that want to
   *   block on a single run (e.g. `dispatchRunAndWait`). Default `false`
   *   preserves the cross-run continuation needed by `/stream`.
   */
  createTailStream(
    taskId: string,
    signal?: AbortSignal,
    opts?: {
      deliverPolicy?: "all" | "new";
      closeOnDone?: boolean;
    },
  ): Promise<ReadableStream | null>;

  /** Purge buffered data for a thread (best-effort, fire-and-forget). */
  purge(taskId: string): void;

  /** Release resources (clear references, called on shutdown). */
  teardown(): void;
}
