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

import type { NatsConnection, Subscription } from "nats";
import type { SSEEvent } from "./sse-hub";
import type {
  LocalEmitFn,
  SSEBroadcastStrategy,
} from "./sse-broadcast-strategy";

const SUBJECT = "mesh.sse.broadcast";

interface NatsSSEMessage {
  originId: string;
  organizationId: string;
  event: SSEEvent;
}

export interface NatsSSEBroadcastOptions {
  getConnection: () => NatsConnection;
}

export class NatsSSEBroadcast implements SSEBroadcastStrategy {
  private sub: Subscription | null = null;
  private localEmit: LocalEmitFn | null = null;
  private readonly originId = crypto.randomUUID();
  private readonly encoder = new TextEncoder();

  constructor(private readonly options: NatsSSEBroadcastOptions) {}

  async start(localEmit: LocalEmitFn): Promise<void> {
    this.localEmit = localEmit;

    if (this.sub) return;
    this.sub = this.options.getConnection().subscribe(SUBJECT);

    const decoder = new TextDecoder();

    (async () => {
      for await (const msg of this.sub!) {
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
          this.localEmit?.(parsed.organizationId, parsed.event as SSEEvent);
        } catch {
          // Malformed message — skip
        }
      }
    })().catch((err) => {
      console.error("[NatsSSEBroadcast] Subscription error:", err);
    });
  }

  broadcast(organizationId: string, event: SSEEvent): void {
    this.localEmit?.(organizationId, event);

    const payload: NatsSSEMessage = {
      originId: this.originId,
      organizationId,
      event,
    };

    try {
      this.options
        .getConnection()
        .publish(SUBJECT, this.encoder.encode(JSON.stringify(payload)));
    } catch (err) {
      console.warn("[NatsSSEBroadcast] Publish failed (non-critical):", err);
    }
  }

  async stop(): Promise<void> {
    this.sub?.unsubscribe();
    this.sub = null;
    this.localEmit = null;
  }
}
