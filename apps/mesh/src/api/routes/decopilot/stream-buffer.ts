/**
 * Stream Buffer Interface
 *
 * Abstraction for treating a NATS JetStream subject as the single source
 * of truth for a run's UI stream. The producer (`streamCore`) pumps chunks
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
   * Subscribe to the per-task subject from the beginning and stream chunks
   * as a ReadableStream. Tails until the `{done: true}` sentinel arrives or
   * the provided `signal` aborts. Returns null when JetStream is unavailable.
   */
  createTailStream(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<ReadableStream | null>;

  /** Purge buffered data for a thread (best-effort, fire-and-forget). */
  purge(taskId: string): void;

  /** Release resources (clear references, called on shutdown). */
  teardown(): void;
}
