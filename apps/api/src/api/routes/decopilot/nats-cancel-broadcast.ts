/**
 * NATS Cancel Broadcast
 *
 * Broadcasts run cancellation across pods via NATS Core pub/sub.
 * When a cancel is received from any pod, the local onCancel callback
 * is invoked to abort the run if it exists on this pod.
 *
 * Cancel is inherently fire-and-forget — if the pod is gone, the run is gone.
 * JetStream persistence would be wrong here (replaying stale cancels).
 */

import type { NatsConnection, Subscription } from "@nats-io/nats-core";
import type { CancelBroadcast } from "./cancel-broadcast";

const CANCEL_SUBJECT = "studio.decopilot.cancel";

export interface NatsCancelBroadcastOptions {
  getConnection: () => NatsConnection | null;
}

export class NatsCancelBroadcast implements CancelBroadcast {
  private subscription: Subscription | null = null;
  private onCancel: ((taskId: string) => void) | null = null;
  private readonly encoder = new TextEncoder();
  private readonly originId = crypto.randomUUID();

  constructor(private readonly options: NatsCancelBroadcastOptions) {}

  async start(onCancel?: (taskId: string) => void): Promise<void> {
    if (onCancel) this.onCancel = onCancel;

    if (this.subscription) return;
    if (!this.onCancel) return;

    const nc = this.options.getConnection();
    if (!nc) return; // NATS not ready — local cancel only

    const decoder = new TextDecoder();
    const subscription = nc.subscribe(CANCEL_SUBJECT);
    this.subscription = subscription;

    (async () => {
      for await (const msg of subscription) {
        try {
          const parsed = JSON.parse(decoder.decode(msg.data)) as {
            taskId: string;
            originId?: string;
          };
          if (parsed.originId === this.originId) continue;
          this.onCancel?.(parsed.taskId);
        } catch {
          // Ignore malformed messages
        }
      }
    })().catch(console.error);
  }

  broadcast(taskId: string): void {
    if (/[.*>\s]/.test(taskId)) {
      console.warn(
        "[NatsCancelBroadcast] Invalid threadId, skipping broadcast",
      );
      return;
    }

    this.onCancel?.(taskId);

    try {
      const nc = this.options.getConnection();
      if (!nc) return; // NATS not ready — local cancel only
      const encoded = this.encoder.encode(
        JSON.stringify({
          taskId,
          originId: this.originId,
        }),
      );
      nc.publish(CANCEL_SUBJECT, encoded);
    } catch (err) {
      console.warn("[NatsCancelBroadcast] Publish failed (non-critical):", err);
    }
  }

  async stop(): Promise<void> {
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.onCancel = null;
  }
}
