/**
 * Registry catalog aggregator — the single source of truth behind the REST
 * route, the (re-sourced) MCP shim, and the builtin store tool.
 *
 * Aggregates N `CatalogSource`s (first-party `registry.json` first, then the
 * community/official feed). Each source is wrapped in a single-flight +
 * stale-while-revalidate loader; a failing source is treated as empty so one
 * bad feed can't sink the store. Items are merged in source-priority order,
 * deduped by `server.name`, then filtered + paginated in-memory.
 */

import { getSettings } from "@/settings";
import { createCachedLoader, type CachedLoader } from "./cached-loader";
import { filterItems } from "./search";
import { firstPartyJsonSource } from "./sources";
import type {
  CatalogItem,
  CatalogListQuery,
  CatalogListResult,
  CatalogSource,
} from "./types";

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export interface CatalogOptions {
  ttlMs?: number;
  /** Injectable clock (forwarded to the per-source loaders) for tests. */
  now?: () => number;
  /** Retry attempts per source load (forwarded to the loaders). */
  maxAttempts?: number;
}

export interface Catalog {
  listItems(query?: CatalogListQuery): Promise<CatalogListResult>;
  getItem(idOrName: string): Promise<CatalogItem | null>;
  /** Eager-load every source (boot warm-up); fail-soft. */
  warm(): Promise<void>;
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset)).toString("base64");
}

function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  const n = Number.parseInt(Buffer.from(cursor, "base64").toString("utf8"), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function dedupeKey(item: CatalogItem): string {
  return item.server?.name?.toLowerCase() ?? item.id;
}

/** Merge sources in priority order; first occurrence of a key wins. */
function mergeDedupe(perSource: CatalogItem[][]): CatalogItem[] {
  const seen = new Set<string>();
  const merged: CatalogItem[] = [];
  for (const items of perSource) {
    for (const item of items) {
      const key = dedupeKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

export function createCatalog(
  sources: CatalogSource[],
  opts: CatalogOptions = {},
): Catalog {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const loaders: Array<{ id: string; loader: CachedLoader<CatalogItem[]> }> =
    sources.map((source) => ({
      id: source.id,
      loader: createCachedLoader<CatalogItem[]>({
        load: (signal) => source.load(signal),
        ttlMs,
        now: opts.now,
        maxAttempts: opts.maxAttempts,
      }),
    }));

  // Per-source isolation: a failing source contributes [] instead of throwing.
  async function loadAll(): Promise<CatalogItem[][]> {
    return Promise.all(
      loaders.map(async ({ id, loader }) => {
        try {
          return await loader.get();
        } catch (err) {
          console.warn(`[registry-catalog] source "${id}" failed:`, err);
          return [] as CatalogItem[];
        }
      }),
    );
  }

  return {
    async listItems(query = {}): Promise<CatalogListResult> {
      const merged = mergeDedupe(await loadAll());
      const filtered = filterItems(merged, query);

      const limit = Math.min(
        Math.max(query.limit ?? DEFAULT_LIMIT, 1),
        MAX_LIMIT,
      );
      const offset = decodeCursor(query.cursor);
      const page = filtered.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      const nextCursor =
        nextOffset < filtered.length ? encodeCursor(nextOffset) : undefined;

      return { items: page, totalCount: filtered.length, nextCursor };
    },

    async getItem(idOrName: string): Promise<CatalogItem | null> {
      const merged = mergeDedupe(await loadAll());
      const base = idOrName.split("@")[0];
      return (
        merged.find(
          (item) =>
            item.id === idOrName ||
            item.server?.name === idOrName ||
            item.server?.name === base,
        ) ?? null
      );
    },

    async warm(): Promise<void> {
      await Promise.all(loaders.map(({ loader }) => loader.warm()));
    },
  };
}

/** Build the sources configured for this deployment (from settings). */
function buildSourcesFromSettings(): CatalogSource[] {
  const sources: CatalogSource[] = [];
  const firstPartyUrl = getSettings().registryCatalogUrl;
  if (firstPartyUrl) {
    sources.push(firstPartyJsonSource(firstPartyUrl));
  }
  // Single-source by design: the curated first-party registry.json IS the whole
  // store catalog — the popular community MCPs are curated into it directly
  // (decocms/mcps). The live community/official feed was intentionally dropped
  // (Supabase mirror retired — see decocms/mcps#478). The aggregator stays
  // N-source-capable in case a second curated source is added later.
  return sources;
}

let singleton: Catalog | null = null;

/** Process-wide catalog, built lazily from settings. */
export function getCatalog(): Catalog {
  singleton ??= createCatalog(buildSourcesFromSettings());
  return singleton;
}
