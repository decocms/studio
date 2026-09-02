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
 * expire on the bucket's TTL, which is what covers the writers this cache
 * never sees: repo sync lands bytes without going through the org-fs routes,
 * so a synced skill appears within the TTL rather than immediately.
 *
 * The TTL bounds THIS layer only. Public-set skills sit behind a second,
 * process-local cache inside `buildSkillCatalog` with a longer window of its
 * own, and a rebuild may read that one while it is still warm — so a
 * public-set change surfaces within roughly the sum of the two, not within
 * this TTL. That is deliberate: public sets are deployment-global, and making
 * every org's rebuild rescan them would undo what their cache is for.
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
 * How long a build may be served before it is rebuilt from storage. Sized by
 * the writer this cache cannot invalidate on: repo sync runs about every 10
 * minutes, so a minute keeps a synced skill's worst-case appearance lag well
 * inside the sync's own period, while still collapsing a page-through of the
 * Settings grid into one build.
 */
const TTL_MS = 60_000;

/**
 * Ceiling on one org's cached catalog. `MAX_SKILLS` (200) x a generous
 * frontmatter description lands well under this; anything above it is a
 * pathological tree that should rebuild rather than sit in NATS memory.
 */
const MAX_VALUE_BYTES = 1024 * 1024;

/**
 * A cache read: the catalog if one is stored, plus the KV revision the key sat
 * at when it was read.
 *
 * The revision is what makes a publish safe. A build takes hundreds of
 * milliseconds of storage reads, and an org-fs write can land inside that
 * window — its `invalidate` then clears a key the in-flight build is about to
 * republish, pre-write, for a whole TTL. Carrying the revision forward turns
 * the publish into a compare-and-swap: anything that touched the key in the
 * meantime moves it, and the losing build drops its result instead.
 */
export interface CachedCatalog {
  catalog: SkillCatalogEntry[] | null;
  /** Absent only when the key has never been written in this bucket. */
  revision?: number;
}

export interface SkillCatalogCache {
  get(orgId: string): Promise<CachedCatalog>;
  /**
   * Publish a build, but only if the key still sits at `revision` (or, when
   * that is absent, has never been written). Losing the race is normal and
   * silent — it means fresher state already won.
   */
  set(
    orgId: string,
    entries: SkillCatalogEntry[],
    revision?: number,
  ): Promise<void>;
  invalidate(orgId: string): Promise<void>;
  teardown(): void;
}

/**
 * Marks an org's catalog as absent. A written tombstone rather than a KV
 * delete: a delete leaves the key in a state `create` is allowed to fill, so
 * an in-flight build that started before the invalidation could still publish
 * over it. A tombstone occupies a revision, which every publish must name.
 */
const TOMBSTONE = new TextEncoder().encode("null");

export interface JetStreamKVSkillCatalogCacheOptions {
  getJetStream: () => JetStreamClient | null;
}

export class JetStreamKVSkillCatalogCache implements SkillCatalogCache {
  private kv: KV | null = null;
  // Nullable: the tombstone `invalidate` writes decodes to `null`.
  private readonly codec = jsonCodec<SkillCatalogEntry[] | null>();

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

  async get(orgId: string): Promise<CachedCatalog> {
    if (!this.kv) return { catalog: null };
    try {
      const entry = await this.kv.get(orgId);
      // No key at all — nothing to compare-and-swap against, so the publish
      // has to `create` instead.
      if (!entry) return { catalog: null };
      // A delete marker or our own tombstone: a miss, but at a real revision.
      if (
        entry.operation === "DEL" ||
        entry.operation === "PURGE" ||
        !entry.value?.length
      ) {
        return { catalog: null, revision: entry.revision };
      }
      const catalog = this.codec.decode(entry.value);
      if (catalog === null) {
        return { catalog: null, revision: entry.revision };
      }
      cacheCounter.add(1, { outcome: "hit" });
      return { catalog, revision: entry.revision };
    } catch {
      // A decode failure is a miss, but republishing over the key that caused
      // it needs the revision — which we no longer trust. Force a `create`,
      // which loses to the existing key and leaves the TTL to clear it.
      return { catalog: null };
    }
  }

  async set(
    orgId: string,
    entries: SkillCatalogEntry[],
    revision?: number,
  ): Promise<void> {
    if (!this.kv) return;
    try {
      const value = this.codec.encode(entries);
      if (revision === undefined) {
        await this.kv.create(orgId, value);
      } else {
        await this.kv.update(orgId, value, revision);
      }
    } catch {
      // Either the value was rejected (oversized) or the compare-and-swap
      // lost — a write invalidated mid-build, or another replica published
      // first. Both mean this build must not land; the next read rebuilds.
    }
  }

  async invalidate(orgId: string): Promise<void> {
    if (!this.kv) return;
    try {
      await this.kv.put(orgId, TOMBSTONE);
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
