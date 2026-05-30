/**
 * Claim registry for active daemon WebSockets.
 *
 * Keyed by `userSub`. Stores which mesh pod is currently holding the daemon's
 * WS, plus the daemon's reported preview port so the cluster can build
 * `<handle>.localhost:<previewPort>` URLs. Replaces the older `LinkRegistry`
 * (which stored a `linkSecret` + `tunnelUrl`).
 *
 * Two backends:
 *   - NATS JetStream KV bucket `studio_links` (production). Bucket-level
 *     `maxAge: 60s`. The owning pod refreshes its entry every ~20s.
 *   - In-memory (tests). Same surface, no NATS.
 *
 * The watcher is the eviction mechanism: when a pod sees the entry's `podId`
 * change to something else, it knows it lost ownership and tears down its WS.
 */

import { JSONCodec, StorageType, type JetStreamClient, type KV } from "nats";
import type { Capability } from "./protocol";

export interface LinkClaim {
  podId: string;
  machineId: string;
  hostname?: string;
  cliVersion: string;
  previewPort: number;
  connectedAt: number;
  /** Capabilities advertised by the daemon in its `hello` frame. */
  capabilities: Capability[];
}

export type ClaimListener = (claim: LinkClaim | null) => void;
export type Unsubscribe = () => void;

export interface LinkClaimRegistry {
  get(userSub: string): Promise<LinkClaim | null>;
  put(userSub: string, claim: LinkClaim): Promise<void>;
  delete(userSub: string): Promise<void>;
  /**
   * Subscribe to claim changes for `userSub`. Fires immediately with the
   * current value (or `null`), then on every put/delete.
   */
  watch(userSub: string, listener: ClaimListener): Unsubscribe;
}

const BUCKET_NAME = "studio_links";
const BUCKET_MAX_AGE_MS = 60_000;

// ── In-memory backend (tests + dev fallback) ──────────────────────────────

export function createInMemoryLinkClaimRegistry(): LinkClaimRegistry {
  const store = new Map<string, LinkClaim>();
  const listeners = new Map<string, Set<ClaimListener>>();

  function fire(userSub: string): void {
    const ls = listeners.get(userSub);
    if (!ls) return;
    const claim = store.get(userSub) ?? null;
    for (const cb of ls) {
      try {
        cb(claim);
      } catch {
        // swallow listener errors
      }
    }
  }

  return {
    async get(userSub) {
      return store.get(userSub) ?? null;
    },
    async put(userSub, claim) {
      store.set(userSub, claim);
      fire(userSub);
    },
    async delete(userSub) {
      store.delete(userSub);
      fire(userSub);
    },
    watch(userSub, listener) {
      let ls = listeners.get(userSub);
      if (!ls) {
        ls = new Set();
        listeners.set(userSub, ls);
      }
      ls.add(listener);
      // initial fire
      try {
        listener(store.get(userSub) ?? null);
      } catch {
        // swallow
      }
      return () => {
        const cur = listeners.get(userSub);
        if (!cur) return;
        cur.delete(listener);
        if (cur.size === 0) listeners.delete(userSub);
      };
    },
  };
}

// ── NATS JS KV backend (production) ────────────────────────────────────────

export interface NatsLinkClaimRegistryOptions {
  getJetStream: () => JetStreamClient | null;
}

export class NatsLinkClaimRegistry implements LinkClaimRegistry {
  private kv: KV | null = null;
  private readonly codec = JSONCodec<LinkClaim>();

  constructor(private readonly options: NatsLinkClaimRegistryOptions) {}

  /** Idempotent. Re-call from `natsProvider.onReady` after a reconnect. */
  async init(): Promise<void> {
    const js = this.options.getJetStream();
    if (!js) return;
    this.kv = await js.views.kv(BUCKET_NAME, {
      history: 1,
      ttl: BUCKET_MAX_AGE_MS,
      storage: StorageType.Memory,
    });
  }

  async get(userSub: string): Promise<LinkClaim | null> {
    if (!this.kv) return null;
    try {
      const entry = await this.kv.get(userSub);
      if (!entry?.value) return null;
      if (entry.operation === "DEL" || entry.operation === "PURGE") return null;
      // Safety net for clusters with looser GC timing.
      const ageMs = Date.now() - entry.created.getTime();
      if (ageMs > BUCKET_MAX_AGE_MS) return null;
      return this.codec.decode(entry.value);
    } catch {
      return null;
    }
  }

  async put(userSub: string, claim: LinkClaim): Promise<void> {
    if (!this.kv) return;
    await this.kv.put(userSub, this.codec.encode(claim));
  }

  async delete(userSub: string): Promise<void> {
    if (!this.kv) return;
    try {
      await this.kv.delete(userSub);
    } catch {
      // best-effort
    }
  }

  watch(userSub: string, listener: ClaimListener): Unsubscribe {
    if (!this.kv) {
      // No connection yet — fire null and return a no-op.
      try {
        listener(null);
      } catch {
        // swallow
      }
      return () => {};
    }
    let stopped = false;
    let watcher: Awaited<ReturnType<KV["watch"]>> | null = null;

    // Auto-reattach loop: if the JS KV watcher errors out (NATS reconnect,
    // server restart, stream rebalance), the inner for-await ends and
    // without reattachment the caller would never observe future eviction
    // events. Back off briefly between attempts so a flapping server
    // doesn't pin a CPU.
    void (async () => {
      let backoffMs = 250;
      while (!stopped) {
        try {
          watcher = await this.kv!.watch({ key: userSub });
          backoffMs = 250; // reset after a successful attach
          for await (const entry of watcher) {
            if (stopped) return;
            const isDelete =
              entry.operation === "DEL" || entry.operation === "PURGE";
            const claim =
              isDelete || !entry.value ? null : this.codec.decode(entry.value);
            try {
              listener(claim);
            } catch {
              // swallow
            }
          }
          // Stream ended without throwing (server-driven). Reattach unless
          // the caller has unsubscribed.
          if (stopped) return;
        } catch {
          // attach or iteration failed — back off and retry.
        }
        if (stopped) return;
        await new Promise<void>((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 5_000);
      }
    })();
    return () => {
      stopped = true;
      try {
        watcher?.stop();
      } catch {
        // ignore
      }
    };
  }
}
