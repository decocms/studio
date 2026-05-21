/**
 * Link Registry
 *
 * Stores per-user `LinkEntry` records for the remote-harness dispatch flow.
 * The cluster looks up an entry by `userId` before deciding whether to run
 * a harness in the cluster sandbox or to dispatch it to the user's link
 * daemon over the registered tunnel URL.
 *
 * Two backends:
 *   - `createNatsLinkRegistry` — production, backed by a NATS JetStream KV
 *     bucket (`LINKS`). Entries expire via the bucket's `ttl` option
 *     (nats@2.29.3 `KvLimits.ttl`, expressed in milliseconds).
 *   - `createInMemoryLinkRegistry` — test/dev only, with a controllable
 *     clock for TTL testing.
 *
 * Storage shape: the `linkSecret` field is the HMAC HASH of the secret
 * (not the raw secret). The raw secret is returned to the link daemon
 * exactly once at registration. NATS operators with read access on the
 * `LINKS` bucket see hashes, not working credentials.
 */
import { JSONCodec, StorageType, type JetStreamClient, type KV } from "nats";
import type { LinkEntry } from "./protocol";

const LINKS_BUCKET = "LINKS";
const DEFAULT_LINK_TTL_SECONDS = 30;

export interface LinkRegistry {
  get(userId: string): Promise<LinkEntry | null>;
  put(userId: string, entry: LinkEntry): Promise<void>;
  delete(userId: string): Promise<void>;
}

/** Test-only: in-memory backend with a controllable clock. */
export interface InMemoryLinkRegistry extends LinkRegistry {
  advanceNow(deltaSeconds: number): void;
}

export function createInMemoryLinkRegistry(opts: {
  ttlSeconds?: number;
  nowSeconds: () => number;
}): InMemoryLinkRegistry {
  const ttl = opts.ttlSeconds ?? DEFAULT_LINK_TTL_SECONDS;
  let drift = 0;
  const nowFn = () => opts.nowSeconds() + drift;
  const store = new Map<string, { entry: LinkEntry; expiresAt: number }>();

  return {
    async get(userId) {
      const slot = store.get(userId);
      if (!slot) return null;
      if (slot.expiresAt <= nowFn()) {
        store.delete(userId);
        return null;
      }
      return slot.entry;
    },
    async put(userId, entry) {
      store.set(userId, { entry, expiresAt: nowFn() + ttl });
    },
    async delete(userId) {
      store.delete(userId);
    },
    advanceNow(delta) {
      drift += delta;
    },
  };
}

export interface NatsLinkRegistryOptions {
  getJetStream: () => JetStreamClient | null;
  /** Defaults to `DEFAULT_LINK_TTL_SECONDS`. */
  ttlSeconds?: number;
}

/**
 * NATS-JetStream-KV backed registry. Mirrors the lazy-init pattern used by
 * the other NATS-backed caches in this codebase: `init()` acquires the KV
 * handle if the connection is up; until then the registry no-ops and reads
 * return null. Re-call `init()` from `natsProvider.onReady` so the registry
 * recovers after a reconnect.
 *
 * Uses bucket-level `max_age` as the freshness ceiling — entries are GC'd
 * by the stream once they age out. The read path includes a freshness check
 * to harden against clusters with looser GC timing. Per-message TTL
 * (JetStream 2.11+) is not required.
 */
export class NatsLinkRegistry implements LinkRegistry {
  private kv: KV | null = null;
  private readonly codec = JSONCodec<LinkEntry>();
  private readonly ttl: number;

  constructor(private readonly options: NatsLinkRegistryOptions) {
    this.ttl = options.ttlSeconds ?? DEFAULT_LINK_TTL_SECONDS;
  }

  async init(): Promise<void> {
    const js = this.options.getJetStream();
    if (!js) return; // NATS not ready — registry disabled until re-init
    this.kv = await js.views.kv(LINKS_BUCKET, {
      history: 1,
      // KvLimits.ttl is documented as "millis the key should live"
      ttl: this.ttl * 1000,
      storage: StorageType.Memory,
    });
  }

  async get(userId: string): Promise<LinkEntry | null> {
    if (!this.kv) return null;
    try {
      const entry = await this.kv.get(userId);
      if (!entry?.value) return null;
      if (entry.operation === "DEL" || entry.operation === "PURGE") {
        return null;
      }
      // Fallback freshness check: compare entry creation time to TTL.
      const ageMs = Date.now() - entry.created.getTime();
      if (ageMs > this.ttl * 1000) return null;
      return this.codec.decode(entry.value);
    } catch {
      return null;
    }
  }

  async put(userId: string, value: LinkEntry): Promise<void> {
    if (!this.kv) return;
    await this.kv.put(userId, this.codec.encode(value));
  }

  async delete(userId: string): Promise<void> {
    if (!this.kv) return;
    try {
      await this.kv.delete(userId);
    } catch {
      // best-effort
    }
  }
}
