/**
 * Cancel Broadcast Interface
 *
 * Abstraction for how run cancellation is broadcast across pods
 * via NATS pub/sub.
 */
export interface CancelBroadcast {
  /** Start listening for cancel broadcasts. When received, call onCancel locally. */
  start(onCancel?: (taskId: string) => void): Promise<void>;
  /** Broadcast a cancellation to all pods (including local). */
  broadcast(taskId: string): void;
  /** Stop listening and release resources. */
  stop(): Promise<void>;
}
