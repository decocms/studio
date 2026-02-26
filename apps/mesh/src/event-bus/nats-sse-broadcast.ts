/**
 * NATS SSE Broadcast Strategy
 *
 * Broadcasts SSE events across pods via NATS Core pub/sub.
 * Each pod subscribes to a shared subject and calls localEmit
 * when it receives a message, so SSE clients on every pod get the event.
 *
 * Uses a per-instance origin ID to avoid double-emitting on the publisher pod.
 */

import { connect, type NatsConnection, type Subscription } from "nats";
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
  servers: string | string[];
}

export class NatsSSEBroadcast implements SSEBroadcastStrategy {
  private nc: NatsConnection | null = null;
  private sub: Subscription | null = null;
  private localEmit: LocalEmitFn | null = null;
  private readonly originId = crypto.randomUUID();

  constructor(private readonly options: NatsSSEBroadcastOptions) {}

  async start(localEmit: LocalEmitFn): Promise<void> {
    if (this.nc) return;

    this.localEmit = localEmit;
    this.nc = await connect({ servers: this.options.servers });
    this.sub = this.nc.subscribe(SUBJECT);

    const decoder = new TextDecoder();

    (async () => {
      for await (const msg of this.sub!) {
        try {
          const payload: NatsSSEMessage = JSON.parse(decoder.decode(msg.data));
          if (payload.originId === this.originId) continue;
          this.localEmit?.(payload.organizationId, payload.event);
        } catch {
          // Malformed message — skip
        }
      }
    })().catch((err) => {
      console.error("[NatsSSEBroadcast] Subscription error:", err);
    });

    console.log("[NatsSSEBroadcast] Started, subscribed to", SUBJECT);
  }

  broadcast(organizationId: string, event: SSEEvent): void {
    // Always emit locally first (fast path for SSE clients on this pod)
    this.localEmit?.(organizationId, event);

    if (!this.nc) return;

    const payload: NatsSSEMessage = {
      originId: this.originId,
      organizationId,
      event,
    };

    try {
      this.nc.publish(
        SUBJECT,
        new TextEncoder().encode(JSON.stringify(payload)),
      );
    } catch (err) {
      console.warn("[NatsSSEBroadcast] Publish failed (non-critical):", err);
    }
  }

  async stop(): Promise<void> {
    this.sub?.unsubscribe();
    this.sub = null;
    this.localEmit = null;

    if (this.nc) {
      await this.nc.drain();
      this.nc = null;
    }

    console.log("[NatsSSEBroadcast] Stopped");
  }
}
