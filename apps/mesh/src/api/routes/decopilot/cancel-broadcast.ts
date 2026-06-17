/**
 * Cancel Broadcast Interface
 *
 * Abstraction for how run cancellation is broadcast across pods
 * via NATS pub/sub.
 */
import type { ControlFrame } from "./control-frames";

export interface CancelBroadcast {
  /** Start listening for cancel broadcasts. When received, call onCancel locally. */
  start(onCancel?: (taskId: string) => void): Promise<void>;
  /** Broadcast a cancellation to all pods (including local). */
  broadcast(taskId: string): void;
  /**
   * Publish a control frame to the user's active link. Fire-and-forget: no-op
   * when no live tunnel claim exists (the durable cancel flag in
   * `cancel_requested_at` is the correctness path).
   */
  publishControlFrame(userSub: string, frame: ControlFrame): void;
  /** Stop listening and release resources. */
  stop(): Promise<void>;
}
