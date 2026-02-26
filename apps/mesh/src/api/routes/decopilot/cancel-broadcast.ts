/**
 * Cancel Broadcast Interface
 *
 * Abstraction for how run cancellation is broadcast across pods.
 * In single-process mode, cancel is local only.
 * In multi-pod deployments, NATS pub/sub propagates cancellation.
 *
 * Mirrors the SSEBroadcastStrategy pattern from event-bus.
 */

export interface CancelBroadcast {
  /** Start listening for cancel broadcasts. When received, call onCancel locally. */
  start(onCancel: (threadId: string) => void): Promise<void>;
  /** Broadcast a cancellation to all pods (including local). */
  broadcast(threadId: string): void;
  /** Stop listening and release resources. */
  stop(): Promise<void>;
}

/**
 * Local-only cancel — cancel only works on the current process.
 * Suitable for single-process deployments and when NATS is unavailable.
 */
export class LocalCancelBroadcast implements CancelBroadcast {
  private onCancel: ((threadId: string) => void) | null = null;

  async start(onCancel: (threadId: string) => void): Promise<void> {
    this.onCancel = onCancel;
  }

  broadcast(threadId: string): void {
    this.onCancel?.(threadId);
  }

  async stop(): Promise<void> {
    this.onCancel = null;
  }
}
