/**
 * NATS SSE Broadcast Strategy
 *
 * Broadcasts SSE events across pods via NATS Core pub/sub.
 * Each pod subscribes to a shared subject and calls localEmit
 * when it receives a message, so SSE clients on every pod get the event.
 *
 * Uses a per-instance origin ID to avoid double-emitting on the publisher pod.
 * Connection is provided by NatsConnectionProvider (does not own/drain).
 */

import type { NatsConnection, Subscription } from "@nats-io/nats-core";
import type { LocalEmitFn, SSEBroadcastStrategy, SSEEvent } from "./sse-hub";

const SUBJECTS = ["studio.sse.broadcast", "mesh.sse.broadcast"] as const;

interface NatsSSEMessage {
  originId: string;
  messageId: string;
  organizationId: string;
  event: SSEEvent;
}

export interface NatsSSEBroadcastOptions {
  getConnection: () => NatsConnection | null;
}

export class NatsSSEBroadcast implements SSEBroadcastStrategy {
  private subscriptions: Subscription[] = [];
  private localEmit: LocalEmitFn | null = null;
  private readonly originId = crypto.randomUUID();
  private readonly encoder = new TextEncoder();
  private readonly seenMessageIds = new Set<string>();

  constructor(private readonly options: NatsSSEBroadcastOptions) {}

  async start(localEmit?: LocalEmitFn): Promise<void> {
    if (localEmit) this.localEmit = localEmit;

    if (this.subscriptions.length > 0) return;
    if (!this.localEmit) return;

    const nc = this.options.getConnection();
    if (!nc) return; // NATS not ready — local SSE still works

    const decoder = new TextDecoder();
    this.subscriptions = SUBJECTS.map((subject) => nc.subscribe(subject));

    for (const subscription of this.subscriptions) {
      (async () => {
        for await (const msg of subscription) {
          try {
            const parsed = JSON.parse(decoder.decode(msg.data));
            if (
              typeof parsed?.originId !== "string" ||
              typeof parsed?.organizationId !== "string" ||
              typeof parsed?.event?.id !== "string" ||
              typeof parsed?.event?.type !== "string"
            ) {
              continue;
            }
            if (parsed.originId === this.originId) continue;
            if (
              typeof parsed.messageId === "string" &&
              this.hasSeen(parsed.messageId)
            ) {
              continue;
            }
            this.localEmit?.(parsed.organizationId, parsed.event as SSEEvent);
          } catch {
            // Malformed message — skip
          }
        }
      })().catch((err) => {
        console.error("[NatsSSEBroadcast] Subscription error:", err);
      });
    }
  }

  broadcast(organizationId: string, event: SSEEvent): void {
    this.localEmit?.(organizationId, event);

    const payload: NatsSSEMessage = {
      originId: this.originId,
      messageId: crypto.randomUUID(),
      organizationId,
      event,
    };

    try {
      const nc = this.options.getConnection();
      if (!nc) return; // NATS not ready — local broadcast only
      const encoded = this.encoder.encode(JSON.stringify(payload));
      for (const subject of SUBJECTS) nc.publish(subject, encoded);
    } catch (err) {
      console.warn("[NatsSSEBroadcast] Publish failed (non-critical):", err);
    }
  }

  async stop(): Promise<void> {
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
    this.subscriptions = [];
    this.seenMessageIds.clear();
    this.localEmit = null;
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
