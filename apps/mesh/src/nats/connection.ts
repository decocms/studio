/**
 * Shared NATS Connection Provider
 *
 * Manages a single NATS connection shared by all NATS implementations:
 * - NatsCancelBroadcast (decopilot cancel)
 * - NatsStreamBuffer (decopilot JetStream relay)
 * - NatsNotifyStrategy (event bus wake-up)
 * - NatsSSEBroadcast (cross-pod SSE fan-out)
 *
 * Benefits:
 * - Single connection to NATS server (recommended best practice)
 * - One place for reconnect logic and error handling
 * - Clear shutdown ordering (drain shared connection last)
 */

import { connect, type JetStreamClient, type NatsConnection } from "nats";

export interface NatsConnectionProvider {
  /** Connect to NATS eagerly. Fails fast if unreachable. */
  init(url: string | string[]): Promise<void>;
  /** Returns the shared connection, or null if not initialized. */
  getConnection(): NatsConnection | null;
  /** Returns a JetStream client from the shared connection, or null. */
  getJetStream(): JetStreamClient | null;
  /** Drain the connection. Call after all consumers have stopped. */
  drain(): Promise<void>;
}

/**
 * Create a NatsConnectionProvider instance.
 * Typically one per process.
 */
export function createNatsConnectionProvider(): NatsConnectionProvider {
  let nc: NatsConnection | null = null;
  let js: JetStreamClient | null = null;

  return {
    async init(url: string | string[]): Promise<void> {
      if (nc) return;
      nc = await connect({ servers: url });
      console.log("[NATS] Connected");
    },

    getConnection(): NatsConnection | null {
      return nc;
    },

    getJetStream(): JetStreamClient | null {
      if (!nc) return null;
      if (!js) {
        js = nc.jetstream();
      }
      return js;
    },

    async drain(): Promise<void> {
      js = null;
      if (nc) {
        const conn = nc;
        nc = null;
        await conn.drain().catch(() => {});
        console.log("[NATS] Connection drained");
      }
    },
  };
}
