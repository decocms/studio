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

import type { NatsConnection, Subscription } from "nats";
import type { NotifyStrategy } from "./notify-strategy";

const SUBJECT = "mesh.events.notify";

export interface NatsNotifyStrategyOptions {
  getConnection: () => NatsConnection;
}

export class NatsNotifyStrategy implements NotifyStrategy {
  private sub: Subscription | null = null;
  private onNotify: (() => void) | null = null;
  private readonly encoder = new TextEncoder();

  constructor(private readonly options: NatsNotifyStrategyOptions) {}

  async start(onNotify: () => void): Promise<void> {
    if (this.sub) return;

    this.onNotify = onNotify;
    this.sub = this.options.getConnection().subscribe(SUBJECT);

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
      this.options
        .getConnection()
        .publish(SUBJECT, this.encoder.encode(eventId));
    } catch (err) {
      console.warn("[NatsNotify] Publish failed (non-critical):", err);
    }
  }
}
