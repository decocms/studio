/**
 * Shared NATS Connection Provider
 *
 * Manages a single NATS connection shared by all NATS implementations:
 * - NatsCancelBroadcast (decopilot cancel)
 * - NatsStreamBuffer (decopilot JetStream relay)
 * - NatsNotifyStrategy (event bus wake-up)
 * - NatsSSEBroadcast (cross-pod SSE fan-out)
 *
 * NATS connection is initialized in the background with exponential backoff.
 * Consumers should use onReady() to defer work until the connection is available.
 */

import {
  type Authenticator,
  credsAuthenticator,
  type NatsConnection,
} from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import { jetstream, type JetStreamClient } from "@nats-io/jetstream";
import { exponentialBackoffWithJitter, sleep } from "@decocms/shared/std";

const BASE_DELAY_MS = 100;
const MAX_DELAY_MS = 3_000;
const CONNECT_TIMEOUT_MS = 3_000;

export interface NatsInitOptions {
  /**
   * NATS creds file body (JWT + seed) for the cluster's own connection. When
   * present the provider authenticates with it; when absent it connects
   * anonymously (production: the cluster connects anonymously to the internal
   * listener). Local dev runs NATS in operator mode where anonymous connect is
   * impossible (`no_auth_user` is incompatible with Trusted Operator mode), so
   * dev passes the persisted cluster creds here.
   */
  creds?: string;
}

export interface NatsConnectionProvider {
  /** Fire-and-forget — starts background connection with retry. */
  init(url: string | string[], options?: NatsInitOptions): void;
  /** Returns true if connected and not closed/draining. */
  isConnected(): boolean;
  /** Returns the shared connection, or null if not connected. */
  getConnection(): NatsConnection | null;
  /** Returns a JetStream client, or null if not connected. */
  getJetStream(): JetStreamClient | null;
  /** Registers a callback that fires when NATS connects. Fires immediately if already connected. */
  onReady(callback: () => void): void;
  /** Stops retry loop, drains connection. */
  drain(): Promise<void>;
}

export interface NatsConnectOptions {
  servers: string | string[];
  timeout: number;
  reconnect: boolean;
  maxReconnectAttempts: number;
  authenticator?: Authenticator;
}

export interface NatsConnectionProviderOptions {
  connectFn?: (opts: NatsConnectOptions) => Promise<NatsConnection>;
}

/**
 * Create a NatsConnectionProvider instance.
 * Typically one per process.
 */
export function createNatsConnectionProvider(
  options?: NatsConnectionProviderOptions,
): NatsConnectionProvider {
  const connectFn = options?.connectFn ?? defaultConnect;

  let nc: NatsConnection | null = null;
  let js: JetStreamClient | null = null;
  let initialized = false;
  let stopped = false;
  let disconnected = false;
  const readyCallbacks: Array<() => void> = [];

  function checkConnected(): boolean {
    return nc !== null && !nc.isClosed() && !nc.isDraining() && !disconnected;
  }

  function fireReady(): void {
    console.log(`[NatsProvider] fireReady: ${readyCallbacks.length} callbacks`);
    for (const cb of readyCallbacks) {
      try {
        cb();
      } catch {
        // swallow callback errors
      }
    }
  }

  function monitorStatus(conn: NatsConnection): void {
    (async () => {
      for await (const s of conn.status()) {
        if (s.type === "disconnect") {
          console.log("[NatsProvider] Disconnected");
          disconnected = true;
        } else if (s.type === "reconnect") {
          console.log("[NatsProvider] Reconnected, re-firing ready callbacks");
          disconnected = false;
          js = null;
          fireReady();
        }
      }
    })().catch(() => {});
  }

  async function connectWithRetry(
    url: string | string[],
    authenticator?: Authenticator,
  ): Promise<void> {
    let attempt = 0;
    while (!stopped) {
      try {
        nc = await connectFn({
          servers: url,
          timeout: CONNECT_TIMEOUT_MS,
          reconnect: true,
          maxReconnectAttempts: -1,
          ...(authenticator ? { authenticator } : {}),
        });
        console.log(
          `[NatsProvider] Connected to ${nc.getServer()} after ${attempt} attempt(s)`,
        );
        js = null; // invalidate cached JetStream client for fresh connection
        disconnected = false;
        monitorStatus(nc);
        fireReady();
        return;
      } catch {
        attempt++;
        const jitteredDelay = exponentialBackoffWithJitter(
          MAX_DELAY_MS,
          BASE_DELAY_MS,
          attempt - 1,
          2,
          0.5,
        );
        await sleep(jitteredDelay);
      }
    }
  }

  return {
    init(url: string | string[], options?: NatsInitOptions): void {
      if (initialized) return;
      initialized = true;
      stopped = false;
      const authenticator = options?.creds
        ? credsAuthenticator(new TextEncoder().encode(options.creds))
        : undefined;
      connectWithRetry(url, authenticator).catch(() => {});
    },

    isConnected(): boolean {
      return checkConnected();
    },

    getConnection(): NatsConnection | null {
      return checkConnected() ? nc : null;
    },

    getJetStream(): JetStreamClient | null {
      if (!checkConnected()) return null;
      if (!js) {
        js = jetstream(nc!);
      }
      return js;
    },

    onReady(callback: () => void): void {
      readyCallbacks.push(callback);
      if (checkConnected()) {
        try {
          callback();
        } catch {
          // swallow callback errors (consistent with fireReady)
        }
      }
    },

    async drain(): Promise<void> {
      stopped = true;
      initialized = false;
      js = null;
      disconnected = false;
      if (nc) {
        const conn = nc;
        nc = null;
        await conn.drain().catch(() => {});
      }
    },
  };
}

function defaultConnect(opts: NatsConnectOptions): Promise<NatsConnection> {
  return connect(opts);
}
