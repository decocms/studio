/**
 * NATS Notify Strategy
 *
 * Uses NATS Core pub/sub to wake up the event bus worker immediately
 * when new events are published, instead of waiting for polling.
 *
 * Architecture:
 * - `notify()`: Publishes to a NATS subject
 * - `start()`: Subscribes to the subject and calls onNotify() on each message
 * - Reconnection is handled transparently by the nats.js client
 */

import { connect, type NatsConnection, type Subscription } from "nats";
import type { NotifyStrategy } from "./notify-strategy";

const SUBJECT = "mesh.events.notify";

export interface NatsNotifyStrategyOptions {
  /** NATS server URL(s), e.g. "nats://localhost:4222" */
  servers: string | string[];
}

export class NatsNotifyStrategy implements NotifyStrategy {
  private nc: NatsConnection | null = null;
  private sub: Subscription | null = null;
  private onNotify: (() => void) | null = null;

  constructor(private readonly options: NatsNotifyStrategyOptions) {}

  async start(onNotify: () => void): Promise<void> {
    if (this.nc) return; // Already started

    this.onNotify = onNotify;
    this.nc = await connect({ servers: this.options.servers });

    this.sub = this.nc.subscribe(SUBJECT);

    // Process messages in background — each message wakes the worker
    (async () => {
      for await (const _msg of this.sub!) {
        this.onNotify?.();
      }
    })().catch((err) => {
      console.error("[NatsNotify] Subscription error:", err);
    });

    console.log("[NatsNotify] Started, subscribed to", SUBJECT);
  }

  async stop(): Promise<void> {
    this.sub?.unsubscribe();
    this.sub = null;
    this.onNotify = null;

    if (this.nc) {
      await this.nc.drain();
      this.nc = null;
    }

    console.log("[NatsNotify] Stopped");
  }

  async notify(eventId: string): Promise<void> {
    if (!this.nc) return;

    try {
      this.nc.publish(SUBJECT, new TextEncoder().encode(eventId));
    } catch (err) {
      // Non-critical — polling safety net will still pick it up
      console.warn("[NatsNotify] Publish failed (non-critical):", err);
    }
  }
}
