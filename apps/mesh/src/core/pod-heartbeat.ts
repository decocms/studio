/**
 * Per-Pod Heartbeat via Postgres Advisory Locks
 *
 * Liveness signal: each pod holds `pg_advisory_lock(hashtext(podId))`
 * on a **dedicated long-lived `pg.Client` connection** for its lifetime.
 * The lock is session-scoped — when that connection dies (TCP close
 * from process kill, OS crash, network drop with keepalive timeout),
 * Postgres releases the lock immediately. Peers detect the death by
 * calling `pg_try_advisory_lock(hashtext(peerId))` on a normal pool
 * connection: success means nobody holds the lock = peer is dead.
 *
 * Compared to TTL-based heartbeats (e.g. NATS KV with bucket TTL):
 *
 *   - Sub-second detection on SIGKILL/OOM/process-crash — TCP RST/FIN
 *     reaches Postgres and the lock is released before the OS even
 *     finishes cleaning up the process. The TTL/poll combo of
 *     KV-based heartbeats took 10-55s for the same case.
 *
 *   - ~25s worst case on hard network partition (with TCP keepalive
 *     tuning); comparable to TTL designs.
 *
 *   - No notification channel needed — Postgres is the single source
 *     of truth, and the periodic poll runs against a cheap query.
 *
 * Pod registry: `studio_pods` table (one row per live pod id). Each pod
 * INSERTs on `start()` and DELETEs on `stop()` (graceful). When the
 * poll loop detects a dead peer, it DELETEs that row too — so the
 * table stays a faithful view of who's actually alive, modulo a
 * one-poll-interval window for orphans.
 */

import { Client, type Pool } from "pg";

const POLL_INTERVAL_MS = 5_000; // Scan for dead peers every 5s

export interface PodHeartbeat {
  init(): Promise<void>;
  /** True once the dedicated liveness connection is established. */
  isReady(): boolean;
  /**
   * Acquire the liveness lock and publish our row to the registry.
   * Returns once both are committed so callers can sequence on it
   * (e.g. avoid logging "Started" before peers can observe us alive).
   */
  start(podId: string): Promise<void>;
  /** Watch for pod deaths. Callback receives the dead podId. */
  onPodDeath(callback: (deadPodId: string) => void): void;
  stop(): Promise<void>;
}

export interface PgPodHeartbeatDeps {
  /**
   * Connection string for the dedicated long-lived liveness client.
   * Mesh's pool URL is fine — we just need our OWN pg.Client so the
   * advisory lock's session lifetime tracks the heartbeat instance.
   */
  connectionString: string;
  /**
   * Shared pool for everything that doesn't need session-bound state:
   * pod registration, probe queries, cleanup.
   */
  pool: Pool;
}

export class PgPodHeartbeat implements PodHeartbeat {
  private livenessClient: Client | null = null;
  private podId: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private deathCallback: ((deadPodId: string) => void) | null = null;
  private pendingDeathCallback: ((deadPodId: string) => void) | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: PgPodHeartbeatDeps) {}

  async init(): Promise<void> {
    // Reset stale state from a previous init (e.g. reconnect).
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.livenessClient) {
      try {
        await this.livenessClient.end();
      } catch {
        // Ignore — we're tearing it down anyway.
      }
      this.livenessClient = null;
    }

    const client = new Client({
      connectionString: this.deps.connectionString,
      // TCP keepalives on the liveness connection so a partitioned
      // client is detected by Postgres within ~25s rather than the
      // default 2h. Process kills don't need this (TCP RST is
      // immediate), but a network drop without RST does.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });

    client.on("error", (err) => {
      // The dedicated connection died unexpectedly. Survivor pods will
      // see our lock release and may trigger recovery on our threads.
      // Best we can do is reconnect ASAP and re-acquire the lock so
      // future probes correctly see us as alive again.
      console.error("[PodHeartbeat] liveness client error:", err);
      if (this.stopped || this.reconnectTimer) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.init()
          .then(() => {
            if (this.podId) this.start(this.podId);
          })
          .catch((e) => console.error("[PodHeartbeat] reconnect failed:", e));
      }, 1_000);
    });

    await client.connect();
    this.livenessClient = client;
  }

  isReady(): boolean {
    return this.livenessClient !== null;
  }

  async start(podId: string): Promise<void> {
    if (!this.livenessClient) return;
    // Allow re-call after a reconnect (this.podId may already be set
    // from the original start). The lock is re-acquired below and the
    // INSERT is idempotent.
    this.podId = podId;
    const client = this.livenessClient;

    // Order matters: acquire the lock FIRST, then make the row
    // visible. A peer poll that races our start would otherwise see
    // the row before the lock is held, win pg_try_advisory_xact_lock,
    // and falsely declare us dead. Holding the lock before the row
    // appears means any probe of our id either finds no row (nothing
    // to probe) or finds the row + the lock held (alive).
    //
    // Session-scoped advisory locks are reference-counted on the same
    // session, so re-acquiring on reconnect is a no-op-or-stack —
    // either way the lock stays held.
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [podId]);
      await this.deps.pool.query(
        "INSERT INTO studio_pods (pod_id) VALUES ($1) ON CONFLICT (pod_id) DO NOTHING",
        [podId],
      );
    } catch (err) {
      console.error("[PodHeartbeat] start sequence failed:", err);
    }

    // Activate death detection — either from a pre-init registration
    // or from a previous run that we're resuming after reconnect.
    const callback = this.pendingDeathCallback ?? this.deathCallback;
    if (callback) {
      this.startDeathPoller(callback);
      this.pendingDeathCallback = null;
    }
  }

  onPodDeath(callback: (deadPodId: string) => void): void {
    this.deathCallback = callback;
    if (!this.livenessClient || !this.podId) {
      // Defer — start() will activate the poller once liveness is up.
      this.pendingDeathCallback = callback;
      return;
    }
    this.startDeathPoller(callback);
  }

  private startDeathPoller(callback: (deadPodId: string) => void): void {
    if (this.pollTimer) return;
    const tick = async () => {
      if (!this.podId) return;
      try {
        const { rows: peers } = await this.deps.pool.query<{
          pod_id: string;
        }>("SELECT pod_id FROM studio_pods WHERE pod_id != $1", [this.podId]);
        for (const { pod_id: peerId } of peers) {
          // Transaction-scoped advisory lock: auto-released when the
          // implicit single-statement transaction commits, so we never
          // need an explicit unlock. Crucially, this is safe against
          // the pool serving the try_lock and the (former) unlock from
          // different clients — session-scoped locks would have leaked
          // on the try_lock's client, blocking future probes for that
          // peer id until the connection was recycled.
          const probe = await this.deps.pool.query<{ got: boolean }>(
            "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got",
            [peerId],
          );
          const got = probe.rows[0]?.got === true;
          if (!got) continue;
          // Lock acquired (and already released by xact commit) →
          // nobody holds the session lock → peer is dead. Clean up
          // their registry row so subsequent polls don't keep
          // re-detecting and re-firing the callback.
          await this.deps.pool
            .query("DELETE FROM studio_pods WHERE pod_id = $1", [peerId])
            .catch(() => {});
          console.log(`[PodHeartbeat:poll] detected vanished pod: ${peerId}`);
          callback(peerId);
        }
      } catch (err) {
        console.error("[PodHeartbeat:poll] scan failed:", err);
      }
    };
    // Don't fire an immediate tick — survivor probes need the lock to
    // exist, and start() schedules the lock acquire async. One
    // POLL_INTERVAL_MS of lag at startup is harmless and avoids a
    // brief false-positive window on cold boot.
    this.pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    // Remove ourselves from the registry first so survivor probes
    // stop targeting us right away.
    if (this.podId) {
      await this.deps.pool
        .query("DELETE FROM studio_pods WHERE pod_id = $1", [this.podId])
        .catch(() => {});
    }
    if (this.livenessClient) {
      try {
        await this.livenessClient.end();
      } catch {
        // Best effort — pod is shutting down anyway.
      }
      this.livenessClient = null;
    }
    this.podId = null;
    this.pendingDeathCallback = null;
  }
}
