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

const CANCEL_SUBJECTS = [
  "studio.decopilot.cancel",
  "mesh.decopilot.cancel",
] as const;

export interface NatsCancelBroadcastOptions {
  getConnection: () => NatsConnection | null;
}

export class NatsCancelBroadcast implements CancelBroadcast {
  private subscriptions: Subscription[] = [];
  private onCancel: ((taskId: string) => void) | null = null;
  private readonly encoder = new TextEncoder();
  private readonly originId = crypto.randomUUID();
  private readonly seenMessageIds = new Set<string>();

  constructor(private readonly options: NatsCancelBroadcastOptions) {}

  async start(onCancel?: (taskId: string) => void): Promise<void> {
    if (onCancel) this.onCancel = onCancel;

    if (this.subscriptions.length > 0) return;
    if (!this.onCancel) return;

    const nc = this.options.getConnection();
    if (!nc) return; // NATS not ready — local cancel only

    const decoder = new TextDecoder();
    this.subscriptions = CANCEL_SUBJECTS.map((subject) =>
      nc.subscribe(subject),
    );

    for (const subscription of this.subscriptions) {
      (async () => {
        for await (const msg of subscription) {
          try {
            const parsed = JSON.parse(decoder.decode(msg.data)) as {
              taskId: string;
              originId?: string;
              messageId?: string;
            };
            if (parsed.originId === this.originId) continue;
            if (parsed.messageId && this.hasSeen(parsed.messageId)) continue;
            this.onCancel?.(parsed.taskId);
          } catch {
            // Ignore malformed messages
          }
        }
      })().catch(console.error);
    }
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
          messageId: crypto.randomUUID(),
        }),
      );
      for (const subject of CANCEL_SUBJECTS) nc.publish(subject, encoded);
    } catch (err) {
      console.warn("[NatsCancelBroadcast] Publish failed (non-critical):", err);
    }
  }

  async stop(): Promise<void> {
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
    this.subscriptions = [];
    this.seenMessageIds.clear();
    this.onCancel = null;
  }

  private hasSeen(messageId: string): boolean {
    if (this.seenMessageIds.has(messageId)) return true;
    this.seenMessageIds.add(messageId);
    if (this.seenMessageIds.size > 1_000) {
      const oldest = this.seenMessageIds.values().next().value;
      if (oldest) this.seenMessageIds.delete(oldest);
    }
    return false;
  }
}
