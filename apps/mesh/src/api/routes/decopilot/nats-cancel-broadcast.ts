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

import type { NatsConnection, Subscription } from "nats";
import type { CancelBroadcast } from "./cancel-broadcast";

const CANCEL_SUBJECT = "mesh.decopilot.cancel";

export interface NatsCancelBroadcastOptions {
  getConnection: () => NatsConnection;
}

export class NatsCancelBroadcast implements CancelBroadcast {
  private sub: Subscription | null = null;
  private onCancel: ((threadId: string) => void) | null = null;
  private readonly encoder = new TextEncoder();
  private readonly originId = crypto.randomUUID();

  constructor(private readonly options: NatsCancelBroadcastOptions) {}

  async start(onCancel: (threadId: string) => void): Promise<void> {
    this.onCancel = onCancel;

    if (this.sub) return;
    this.sub = this.options.getConnection().subscribe(CANCEL_SUBJECT);

    const decoder = new TextDecoder();

    (async () => {
      for await (const msg of this.sub!) {
        try {
          const parsed = JSON.parse(decoder.decode(msg.data)) as {
            threadId: string;
            originId?: string;
          };
          if (parsed.originId === this.originId) continue;
          this.onCancel?.(parsed.threadId);
        } catch {
          // Ignore malformed messages
        }
      }
    })().catch(console.error);
  }

  broadcast(threadId: string): void {
    if (/[.*>\s]/.test(threadId)) {
      console.warn(
        "[NatsCancelBroadcast] Invalid threadId, skipping broadcast",
      );
      return;
    }

    this.onCancel?.(threadId);

    try {
      this.options
        .getConnection()
        .publish(
          CANCEL_SUBJECT,
          this.encoder.encode(
            JSON.stringify({ threadId, originId: this.originId }),
          ),
        );
    } catch (err) {
      console.warn("[NatsCancelBroadcast] Publish failed (non-critical):", err);
    }
  }

  async stop(): Promise<void> {
    this.sub?.unsubscribe();
    this.sub = null;
    this.onCancel = null;
  }
}
