/**
 * Per-Pod Heartbeat via NATS KV
 *
 * A single KV key per pod, refreshed on a timer, with bucket-level TTL.
 * Survivor pods learn of dead peers via two complementary mechanisms:
 *
 *   - **Watch** (`kv.watch()`) — fires synchronously on explicit
 *     `kv.delete()` from a graceful shutdown. Near-instant for clean
 *     stops but doesn't fire on TTL-based expiry (NATS' background
 *     cleanup removes expired KV entries server-side without emitting
 *     any consumer-visible operation).
 *
 *   - **Poll** (`kv.keys()` on a timer) — closes the gap for hard
 *     kills (SIGKILL, OOM, network partition) where the dying pod
 *     never gets to send the DEL. Diffs successive scans; anything
 *     in the previous snapshot but not the current one is treated as
 *     dead.
 *
 * O(1) writes per pod regardless of thread count; O(pods) per poll
 * tick.
 */

import type { JetStreamClient, NatsConnection, KV } from "nats";
import { StorageType } from "nats";

const BUCKET_NAME = "POD_HEARTBEATS";
const BUCKET_TTL_MS = 45_000; // Key expires 45s after last refresh
const REFRESH_INTERVAL_MS = 10_000; // Refresh every 10s
const POLL_INTERVAL_MS = 10_000; // Scan for vanished keys every 10s

export interface PodHeartbeat {
  init(): Promise<void>;
  /** True once `init()` has successfully created/opened the KV bucket. */
  isReady(): boolean;
  start(podId: string): void;
  /** Watch for pod deaths. Callback receives the dead podId. */
  onPodDeath(callback: (deadPodId: string) => void): void;
  stop(): Promise<void>;
}

export interface NatsPodHeartbeatDeps {
  getConnection: () => NatsConnection | null;
  getJetStream: () => JetStreamClient | null;
}

export class NatsPodHeartbeat implements PodHeartbeat {
  private kv: KV | null = null;
  private podId: string | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private knownPods: Set<string> = new Set();
  private watchAbortController: AbortController | null = null;
  private initPromise: Promise<void> | null = null;
  private pendingDeathCallback: ((deadPodId: string) => void) | null = null;
  private deathCallback: ((deadPodId: string) => void) | null = null;

  constructor(private readonly deps: NatsPodHeartbeatDeps) {}

  async init(): Promise<void> {
    // Stop old watcher and clear stale state so we re-create from scratch
    if (this.watchAbortController) {
      this.watchAbortController.abort();
      this.watchAbortController = null;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.knownPods = new Set();
    this.kv = null;
    this.initPromise = null;

    const js = this.deps.getJetStream();
    if (!js) return; // NATS not ready — heartbeat disabled until re-init
    this.initPromise = js.views
      .kv(BUCKET_NAME, {
        ttl: BUCKET_TTL_MS,
        storage: StorageType.Memory,
      })
      .then((kv) => {
        this.kv = kv;
      })
      .catch((err) => {
        this.initPromise = null;
        throw err;
      });
    return this.initPromise;
  }

  isReady(): boolean {
    return this.kv !== null;
  }

  start(podId: string): void {
    if (!this.kv) return; // Not initialized — skip heartbeat
    if (this.refreshTimer) return; // Already running — prevent double start
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

    // Re-arm death detection. Two cases land here:
    //   - First start after onPodDeath() was called pre-init:
    //     `pendingDeathCallback` holds the callback.
    //   - NATS reconnect: `init()` tore down the watcher and poller,
    //     `pendingDeathCallback` is null (it was consumed on the first
    //     start), but `deathCallback` is still cached on the instance.
    // Without this fallback, heartbeats keep refreshing after a
    // reconnect but death detection silently stops firing — every
    // peer death goes unnoticed until the next pod restart.
    const callback = this.pendingDeathCallback ?? this.deathCallback;
    if (callback) {
      this.startDeathWatcher(callback);
      this.startDeathPoller();
      this.pendingDeathCallback = null;
    }
  }

  onPodDeath(callback: (deadPodId: string) => void): void {
    this.deathCallback = callback;
    if (!this.kv) {
      // Store callback — will activate when start() runs after init()
      this.pendingDeathCallback = callback;
      return;
    }
    this.startDeathWatcher(callback);
    this.startDeathPoller();
  }

  /**
   * Periodic scan that catches deaths the watcher misses. NATS KV
   * TTL-based key expiry happens server-side without emitting any
   * notification on the consumer — so a SIGKILL'd pod's key just
   * vanishes from the bucket silently. We list keys on a timer,
   * diff against the previous snapshot, and treat absences as
   * deaths.
   */
  private startDeathPoller(): void {
    if (this.pollTimer) return;
    if (!this.kv) return;
    const kv = this.kv;

    const tick = async () => {
      try {
        const live = new Set<string>();
        const iter = await kv.keys();
        for await (const key of iter) {
          live.add(key);
        }
        // First tick: just record the baseline. Don't fire deaths for
        // pods we never knew about — the watcher's initial sync
        // covered those.
        if (this.knownPods.size === 0) {
          this.knownPods = live;
          return;
        }
        for (const prev of this.knownPods) {
          if (!live.has(prev) && prev !== this.podId && this.deathCallback) {
            console.log(`[PodHeartbeat:poll] detected vanished key: ${prev}`);
            this.deathCallback(prev);
          }
        }
        // Update snapshot — additions (new pods joining) become
        // tracked, vanished pods drop out.
        this.knownPods = live;
      } catch (err) {
        console.error("[PodHeartbeat:poll] scan failed:", err);
      }
    };
    // Fire one immediate tick to seed the baseline, then on interval.
    tick();
    this.pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  }

  private startDeathWatcher(callback: (deadPodId: string) => void): void {
    if (!this.kv) return;

    this.watchAbortController = new AbortController();
    const kv = this.kv;
    const ownPodId = this.podId;
    const signal = this.watchAbortController.signal;

    const startWatcher = async () => {
      while (!signal.aborted) {
        try {
          const watcher = await kv.watch();

          for await (const entry of watcher) {
            if (signal.aborted) break;

            // DEL fires on explicit graceful kv.delete(); PURGE on
            // explicit kv.purge(). TTL-based expiry doesn't fire
            // either — the poller covers that case.
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
    // 1. Stop refresh + poll timers
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
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
    this.initPromise = null;
    this.pendingDeathCallback = null;
  }
}
