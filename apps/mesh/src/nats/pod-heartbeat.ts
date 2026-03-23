/**
 * Per-Pod Heartbeat via NATS KV
 *
 * A single KV key per pod, refreshed on a timer, with bucket-level TTL.
 * When a pod dies (hard kill) or shuts down (graceful), its key expires/deletes
 * and watchers on other pods are notified immediately.
 *
 * O(1) writes per pod regardless of thread count.
 */

import type { JetStreamClient, NatsConnection, KV } from "nats";
import { StorageType } from "nats";

const BUCKET_NAME = "POD_HEARTBEATS";
const BUCKET_TTL_MS = 45_000; // Key expires 45s after last refresh
const REFRESH_INTERVAL_MS = 10_000; // Refresh every 10s

export interface PodHeartbeat {
  init(): Promise<void>;
  start(podId: string): void;
  /** Watch for pod deaths. Callback receives the dead podId. */
  onPodDeath(callback: (deadPodId: string) => void): void;
  stop(): Promise<void>;
}

export interface NatsPodHeartbeatDeps {
  getConnection: () => NatsConnection;
  getJetStream: () => JetStreamClient;
}

export class NatsPodHeartbeat implements PodHeartbeat {
  private kv: KV | null = null;
  private podId: string | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private watchAbortController: AbortController | null = null;

  constructor(private readonly deps: NatsPodHeartbeatDeps) {}

  async init(): Promise<void> {
    const js = this.deps.getJetStream();
    this.kv = await js.views.kv(BUCKET_NAME, {
      ttl: BUCKET_TTL_MS,
      storage: StorageType.Memory,
    });
  }

  start(podId: string): void {
    if (!this.kv) throw new Error("[PodHeartbeat] Not initialized");
    this.podId = podId;

    // Immediate first heartbeat
    this.kv.put(podId, new TextEncoder().encode(new Date().toISOString()));

    // Refresh on interval
    this.refreshTimer = setInterval(() => {
      this.kv
        ?.put(podId, new TextEncoder().encode(new Date().toISOString()))
        .catch((err) => {
          console.error("[PodHeartbeat] Refresh failed:", err);
        });
    }, REFRESH_INTERVAL_MS);
  }

  onPodDeath(callback: (deadPodId: string) => void): void {
    if (!this.kv) throw new Error("[PodHeartbeat] Not initialized");

    this.watchAbortController = new AbortController();
    const kv = this.kv;
    const ownPodId = this.podId;
    const signal = this.watchAbortController.signal;

    const startWatcher = async () => {
      while (!signal.aborted) {
        try {
          const watcher = await kv.watch({
            // Watch all keys
            initializedFn: () => {
              // Initial values loaded, now watching for changes
            },
          });

          for await (const entry of watcher) {
            if (signal.aborted) break;

            // DEL = explicit delete, PURGE = TTL expiry
            if (entry.operation === "DEL" || entry.operation === "PURGE") {
              const deadPodId = entry.key;
              // Don't notify about own pod death
              if (deadPodId !== ownPodId) {
                callback(deadPodId);
              }
            }
          }
        } catch (err) {
          if (signal.aborted) break;
          console.error(
            "[PodHeartbeat] Watcher error, reconnecting in 1s:",
            err,
          );
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    };

    startWatcher().catch((err) => {
      if (!signal.aborted) {
        console.error("[PodHeartbeat] Watcher loop failed:", err);
      }
    });
  }

  async stop(): Promise<void> {
    // 1. Stop refresh timer
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    // 2. Delete own key (triggers watcher on other pods immediately)
    if (this.kv && this.podId) {
      try {
        await this.kv.delete(this.podId);
      } catch {
        // Best effort — pod is shutting down anyway
      }
    }

    // 3. Stop watcher
    if (this.watchAbortController) {
      this.watchAbortController.abort();
      this.watchAbortController = null;
    }

    this.kv = null;
    this.podId = null;
  }
}
