/**
 * Shared NATS Connection Provider
 *
 * Manages a single NATS connection shared by all NATS implementations:
 * - NatsCancelBroadcast (decopilot cancel)
 * - NatsStreamBuffer (decopilot JetStream relay)
 * - NatsNotifyStrategy (event bus wake-up)
 * - NatsSSEBroadcast (cross-pod SSE fan-out)
 *
 * NATS is a required dependency — init() must be called and succeed before
 * using getConnection()/getJetStream(). The app will crash fast if NATS
 * is unreachable.
 */

import { connect, type JetStreamClient, type NatsConnection } from "nats";

export interface NatsConnectionProvider {
  /** Connect to NATS eagerly. Fails fast if unreachable. */
  init(url: string | string[]): Promise<void>;
  /** Returns the shared connection. Throws if not initialized. */
  getConnection(): NatsConnection;
  /** Returns a JetStream client from the shared connection. Throws if not initialized. */
  getJetStream(): JetStreamClient;
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
    },

    getConnection(): NatsConnection {
      if (!nc) throw new Error("[NATS] Not initialized — call init() first");
      return nc;
    },

    getJetStream(): JetStreamClient {
      if (!nc) throw new Error("[NATS] Not initialized — call init() first");
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
      }
    },
  };
}
