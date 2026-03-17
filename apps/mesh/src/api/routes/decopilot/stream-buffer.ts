/**
 * Stream Buffer Interface
 *
 * Abstraction for buffering UIMessageStream chunks so late-joining
 * clients can replay them from any pod via NATS JetStream.
 */

/**
 * StreamBuffer allows buffering and replaying UIMessageStream chunks
 * for late-joining clients (the /attach endpoint).
 */
export interface StreamBuffer {
  /** Initialize the buffer (e.g., ensure JetStream stream exists). */
  init(): Promise<void>;

  /**
   * Wrap a ReadableStream so every chunk is also buffered.
   * Returns a new stream that passes through all chunks unchanged.
   */
  relay(
    stream: ReadableStream,
    threadId: string,
    abortSignal?: AbortSignal,
  ): ReadableStream;

  /**
   * Create a replay stream for a late-joining client.
   * Returns null if the thread has no data.
   */
  createReplayStream(threadId: string): Promise<ReadableStream | null>;

  /** Purge buffered data for a thread (best-effort, fire-and-forget). */
  purge(threadId: string): void;

  /** Release resources (clear references, called on shutdown). */
  teardown(): void;
}
