/**
 * Catalog sources + normalization.
 *
 * Source 1 (implemented): the first-party `registry.json` flat array from
 * `decocms/mcps`, fetched over HTTPS. Each element is either the bare
 * `{ server, _meta }` envelope (what `rowToRegistryServer` emits) or the
 * richer LIST shape `{ id, title, created_at, updated_at, server, _meta }`;
 * `toCatalogItem` derives the missing top-level fields.
 *
 * The catalog is single-source: registry.json is the whole store (popular
 * community MCPs are curated into it directly). A live community/official feed
 * was intentionally dropped. The aggregator stays N-source-capable, so a second
 * curated source could be added later as one more `CatalogSource`.
 */

import type { CatalogItem, CatalogServer, CatalogSource } from "./types";

const DEFAULT_TIMEOUT_MS = 5_000;
/** Defensive cap on a fetched catalog so a runaway/hostile source can't OOM. */
const MAX_ITEMS = 10_000;

const OFFICIAL_META_KEY = "io.modelcontextprotocol.registry/official";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Pull `{ items }` / `{ servers }` / bare-array into a flat element list. */
function toElementArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const rec = asRecord(raw);
  if (rec) {
    if (Array.isArray(rec.items)) return rec.items;
    if (Array.isArray(rec.servers)) return rec.servers;
  }
  return [];
}

/**
 * Normalize one raw element into a `CatalogItem`, or `null` if it lacks a
 * usable `server.name` (the only field every consumer needs).
 */
export function toCatalogItem(raw: unknown): CatalogItem | null {
  const rec = asRecord(raw);
  if (!rec) return null;

  const server = asRecord(rec.server) as CatalogServer | null;
  if (!server || typeof server.name !== "string" || server.name.length === 0) {
    return null;
  }

  const meta = asRecord(rec._meta);
  const official = meta ? asRecord(meta[OFFICIAL_META_KEY]) : null;

  const id =
    typeof rec.id === "string" && rec.id.length > 0
      ? rec.id
      : typeof server.version === "string"
        ? `${server.name}@${server.version}`
        : server.name;

  const title =
    typeof rec.title === "string" && rec.title.length > 0
      ? rec.title
      : typeof server.title === "string"
        ? server.title
        : server.name;

  const created_at =
    typeof rec.created_at === "string"
      ? rec.created_at
      : typeof official?.publishedAt === "string"
        ? (official.publishedAt as string)
        : "";

  const updated_at =
    typeof rec.updated_at === "string"
      ? rec.updated_at
      : typeof official?.updatedAt === "string"
        ? (official.updatedAt as string)
        : created_at;

  return {
    ...rec,
    id,
    title,
    created_at,
    updated_at,
    server,
    _meta: meta ?? undefined,
  } as CatalogItem;
}

/** Parse + normalize a fetched catalog payload, capping the item count. */
export function normalizeCatalog(raw: unknown): CatalogItem[] {
  const elements = toElementArray(raw);
  if (elements.length > MAX_ITEMS) {
    throw new Error(
      `registry catalog has ${elements.length} items, exceeding the ${MAX_ITEMS} cap`,
    );
  }
  const items: CatalogItem[] = [];
  for (const el of elements) {
    const item = toCatalogItem(el);
    if (item) items.push(item);
  }
  return items;
}

export interface FirstPartySourceOptions {
  timeoutMs?: number;
  /** Injectable fetch for unit tests (no real network). */
  fetchImpl?: typeof fetch;
}

/** A `CatalogSource` backed by a flat `registry.json` at `url` (HTTPS GET). */
export function firstPartyJsonSource(
  url: string,
  opts: FirstPartySourceOptions = {},
): CatalogSource {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    id: "first-party",
    async load(signal) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const res = await doFetch(url, { signal: combined });
      if (!res.ok) {
        throw new Error(`registry catalog fetch ${url} → ${res.status}`);
      }
      return normalizeCatalog(await res.json());
    },
  };
}
