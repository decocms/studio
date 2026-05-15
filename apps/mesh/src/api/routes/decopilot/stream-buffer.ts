/**
 * Stream Buffer Interface
 *
 * Abstraction for treating a NATS JetStream subject as the single source
 * of truth for a run's UI stream. The producer (`dispatchRun`) pumps chunks
 * into JetStream via `pump()`; every HTTP response — both initial `/stream`
 * and any `/attach` — reads from JetStream via `createTailStream()`. The
 * producer's lifetime is bound to the run registry, not to any HTTP
 * consumer, so a proxy/idle/tab-close on the consumer side never stalls or
 * drops chunks.
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
   * Detached pump from `stream` into the per-task subject. Fire-and-forget:
   * returns synchronously, then drains `stream` in the background, publishing
   * each chunk as a JetStream message. When `stream` ends (or `registrySignal`
   * aborts), publishes a `{done: true}` sentinel so tail consumers can close.
   *
   * The pump is the sole consumer of `stream`; do not also `pipeThrough` or
   * `tee` it for the HTTP response. Tail consumers read from JetStream via
   * `createTailStream`.
   */
  pump(
    stream: ReadableStream,
    taskId: string,
    registrySignal: AbortSignal,
  ): void;

  /**
   * Publish a single chunk onto the per-task subject. Used for out-of-band
   * events (e.g. queue state transitions) that need to interleave with the
   * run's UI stream without going through the pump.
   *
   * Fire-and-forget: publish errors are logged and dropped, same as `pump`.
   * No-op when JetStream isn't configured.
   */
  publish(taskId: string, chunk: unknown): void;

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
   *   preserves the cross-run continuation needed by `/attach`.
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
