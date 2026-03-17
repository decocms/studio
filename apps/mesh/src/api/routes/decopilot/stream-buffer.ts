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
   * If the buffer is unavailable, returns the original stream as-is.
   */
  relay(
    stream: ReadableStream,
    threadId: string,
    abortSignal?: AbortSignal,
  ): ReadableStream;

  /**
   * Create a replay stream for a late-joining client.
   * Returns null if buffering is not available or the thread has no data.
   */
  createReplayStream(threadId: string): Promise<ReadableStream | null>;

  /** Purge buffered data for a thread (best-effort, fire-and-forget). */
  purge(threadId: string): void;

  /** Release resources (clear references, called on shutdown). */
  teardown(): void;
}

export class NoOpStreamBuffer implements StreamBuffer {
  async init(): Promise<void> {}

  relay(stream: ReadableStream): ReadableStream {
    return stream;
  }

  async createReplayStream(): Promise<ReadableStream | null> {
    return null;
  }

  purge(): void {}

  teardown(): void {}
}
