/**
 * Cross-replica cache for a built skill catalog, over NATS JetStream KV.
 *
 * `buildSkillCatalog` costs one S3 GET per skill (every `SKILL.md` is read and
 * parsed) plus a listing per volume. That is the whole latency of
 * `/fs/skills` and of the `<available-skills>` block a run opens with, and
 * without a cache every replica pays it on every request.
 *
 * KV rather than a per-process Map so a rolling deploy, a scaled-out replica
 * set, and the run path all share one build. Values are memory-backed and
 * expire on the bucket's TTL, which is what covers writers this cache never
 * sees — repo sync and the public-set sync land bytes without going through
 * the org-fs routes.
 *
 * Best-effort throughout: no NATS, a cold bucket, an oversized value, or a
 * decode failure all read as a miss and rebuild. Mirrors
 * {@link ../mcp-clients/mcp-list-cache.ts JetStreamKVMcpListCache}.
 */

import { type JetStreamClient, StorageType } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import { jsonCodec } from "../nats/json-codec";
import { meter } from "../observability";
import type { SkillCatalogEntry } from "./skill-catalog";

const cacheCounter = meter.createCounter("skill_catalog_cache.fetches", {
  description: "Skill catalog cache fetch outcomes (hit, miss)",
  unit: "{fetches}",
});

const KV_BUCKET = "DECOCMS_SKILL_CATALOGS";

/**
 * How long a build may be served before it is rebuilt from storage. The floor
 * is set by the writers this cache cannot invalidate on: repo sync runs about
 * every 10 minutes, so a minute keeps a synced skill's worst-case appearance
 * lag within the sync's own jitter, while still collapsing a page-through of
 * the Settings grid into one build.
 */
const TTL_MS = 60_000;

/**
 * Ceiling on one org's cached catalog. `MAX_SKILLS` (200) x a generous
 * frontmatter description lands well under this; anything above it is a
 * pathological tree that should rebuild rather than sit in NATS memory.
 */
const MAX_VALUE_BYTES = 1024 * 1024;

export interface SkillCatalogCache {
  get(orgId: string): Promise<SkillCatalogEntry[] | null>;
  set(orgId: string, entries: SkillCatalogEntry[]): Promise<void>;
  invalidate(orgId: string): Promise<void>;
  teardown(): void;
}

export interface JetStreamKVSkillCatalogCacheOptions {
  getJetStream: () => JetStreamClient | null;
}

export class JetStreamKVSkillCatalogCache implements SkillCatalogCache {
  private kv: KV | null = null;
  private readonly codec = jsonCodec<SkillCatalogEntry[]>();

  constructor(private readonly options: JetStreamKVSkillCatalogCacheOptions) {}

  async init(): Promise<void> {
    const js = this.options.getJetStream();
    if (!js) return; // NATS not ready — cache disabled until re-init
    this.kv = await new Kvm(js).create(KV_BUCKET, {
      storage: StorageType.Memory,
      ttl: TTL_MS,
      maxValueSize: MAX_VALUE_BYTES,
    });
  }

  async get(orgId: string): Promise<SkillCatalogEntry[] | null> {
    if (!this.kv) return null;
    try {
      const entry = await this.kv.get(orgId);
      if (!entry?.value?.length) return null;
      // A tombstone carries no value worth decoding.
      if (entry.operation === "DEL" || entry.operation === "PURGE") return null;
      const catalog = this.codec.decode(entry.value);
      cacheCounter.add(1, { outcome: "hit" });
      return catalog;
    } catch {
      return null;
    }
  }

  async set(orgId: string, entries: SkillCatalogEntry[]): Promise<void> {
    if (!this.kv) return;
    try {
      await this.kv.put(orgId, this.codec.encode(entries));
    } catch {
      // best-effort, non-critical — an oversized or rejected value just means
      // the next read rebuilds.
    }
  }

  async invalidate(orgId: string): Promise<void> {
    if (!this.kv) return;
    try {
      await this.kv.delete(orgId);
    } catch {
      // best-effort: the TTL is the backstop.
    }
  }

  teardown(): void {
    this.kv = null;
  }
}

/** Records a rebuild. Counted here so hit and miss share one instrument. */
export function recordSkillCatalogMiss(): void {
  cacheCounter.add(1, { outcome: "miss" });
}

// Module-level active cache — set once at app startup.
let activeCache: SkillCatalogCache | null = null;

export function setSkillCatalogCache(cache: SkillCatalogCache | null): void {
  activeCache = cache;
}

export function getSkillCatalogCache(): SkillCatalogCache | null {
  return activeCache;
}

/**
 * Drop an org's cached catalog. Called from the org-fs write path, so an
 * imported or deleted skill shows up on the very next read instead of waiting
 * out the TTL. Awaited by its callers: the UI refetches the catalog as soon as
 * the write responds, and a delete that lands after that read serves stale.
 */
export async function invalidateSkillCatalog(orgId: string): Promise<void> {
  await activeCache?.invalidate(orgId);
}
