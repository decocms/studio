/**
 * Cancel Broadcast Interface
 *
 * Abstraction for how run cancellation is broadcast across pods
 * via NATS pub/sub.
 */

export interface CancelBroadcast {
  /** Start listening for cancel broadcasts. When received, call onCancel locally. */
  start(onCancel: (threadId: string) => void): Promise<void>;
  /** Broadcast a cancellation to all pods (including local). */
  broadcast(threadId: string): void;
  /** Stop listening and release resources. */
  stop(): Promise<void>;
}

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
