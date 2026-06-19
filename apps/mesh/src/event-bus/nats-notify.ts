/**
 * NATS Notify Strategy
 *
 * Uses NATS Core pub/sub to wake up the event bus worker immediately
 * when new events are published, instead of waiting for polling.
 *
 * Architecture:
 * - `notify()`: Publishes to a NATS subject
 * - `start()`: Subscribes to the subject and calls onNotify() on each message
 * - Connection is provided by NatsConnectionProvider (does not own/drain)
 */

import type { NatsConnection, Subscription } from "@nats-io/nats-core";
import type { NotifyStrategy } from "./notify-strategy";

const SUBJECT = "mesh.events.notify";

export interface NatsNotifyStrategyOptions {
  getConnection: () => NatsConnection | null;
}

export class NatsNotifyStrategy implements NotifyStrategy {
  private sub: Subscription | null = null;
  private onNotify: (() => void) | null = null;
  private readonly encoder = new TextEncoder();

  constructor(private readonly options: NatsNotifyStrategyOptions) {}

  async start(onNotify?: () => void): Promise<void> {
    if (this.sub) return;
    if (onNotify) this.onNotify = onNotify;
    if (!this.onNotify) return;

    const nc = this.options.getConnection();
    if (!nc) return; // NATS not ready — polling strategy is safety net

    this.sub = nc.subscribe(SUBJECT);

    (async () => {
      for await (const _msg of this.sub!) {
        this.onNotify?.();
      }
    })().catch((err) => {
      console.error("[NatsNotify] Subscription error:", err);
    });
  }

  async stop(): Promise<void> {
    this.sub?.unsubscribe();
    this.sub = null;
    this.onNotify = null;
  }

  async notify(eventId: string): Promise<void> {
    try {
      const nc = this.options.getConnection();
      if (!nc) return; // NATS not ready — event bus will poll
      nc.publish(SUBJECT, this.encoder.encode(eventId));
    } catch (err) {
      console.warn("[NatsNotify] Publish failed (non-critical):", err);
    }
  }
}
