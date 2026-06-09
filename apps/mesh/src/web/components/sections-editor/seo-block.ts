import type { LiveMeta } from "./resolve-schema";
import { unwrapSeoConfig, wrapSeoPersistValue } from "./seo-lazy-render";
import {
  isSeoSectionResolveType,
  listPageSeoTypeOptions,
  listSiteSeoTypeOptions,
  resolvePageSeoResolveType,
  resolveSiteSeoResolveType,
  type SeoTypeOption,
} from "./seo-schema";

const PAGE_RESOLVE_TYPES = new Set([
  "website/pages/Page.tsx",
  "$live/pages/LivePage.tsx",
]);

/** Default deco SEO section type when manifest schemas are unavailable. */
export const DEFAULT_SEO_RESOLVE_TYPE = "website/sections/Seo/SeoV2.tsx";

/** Props that mark an object as SEO config even without a `__resolveType`. */
const SEO_FIELD_HINTS = [
  "title",
  "titleTemplate",
  "description",
  "descriptionTemplate",
  "image",
  "favicon",
  "type",
  "noIndexing",
];

export interface SiteSeoEntry {
  /** Decofile key of the block that owns the SEO data. */
  blockKey: string;
  /**
   * "block": the decofile entry *is* the SEO block — saving replaces the entry.
   * "nested": the SEO lives under `entry.seo` on a config block (e.g. the
   * website/site app) — saving writes `{ ...blockData, seo }`.
   */
  kind: "block" | "nested";
  seoData: Record<string, unknown>;
  blockData: Record<string, unknown>;
  /** resolveType to resolve the form schema with (SEO props may be inlined). */
  seoResolveType: string;
}

/** Narrows a decofile value to a plain (non-array) object. */
function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function looksLikeSeo(obj: Record<string, unknown>): boolean {
  if (
    typeof obj.__resolveType === "string" &&
    isSeoSectionResolveType(obj.__resolveType)
  ) {
    return true;
  }
  return SEO_FIELD_HINTS.some((k) => k in obj);
}

/**
 * Finds the site-level (default) SEO that pages inherit from. Deco sites store
 * this in one of a few shapes, checked in order:
 *
 *   1. SEO nested under a non-page config block (e.g. the `site` app config's
 *      `seo` prop) — often inlined props with no `__resolveType`. This is the
 *      true "applied to every page unless overridden" default.
 *   2. A standalone SEO block — a decofile entry whose own `__resolveType` is
 *      an SEO type (the block *is* the SEO).
 */
export function findSiteSeoEntry(
  decofile: Record<string, unknown>,
  meta?: LiveMeta,
): SiteSeoEntry | null {
  // 1) SEO nested on a non-page config block.
  for (const [key, val] of Object.entries(decofile)) {
    if (!isPlainObject(val)) continue;
    const obj = val;
    const rt = obj.__resolveType;
    if (typeof rt === "string" && PAGE_RESOLVE_TYPES.has(rt)) continue;
    const seo = obj.seo;
    if (isPlainObject(seo)) {
      const seoObj = seo;
      if (looksLikeSeo(seoObj)) {
        return {
          blockKey: key,
          kind: "nested",
          seoData: seoObj,
          blockData: obj,
          seoResolveType: meta
            ? resolveSiteSeoResolveType(meta, obj, seoObj)
            : typeof seoObj.__resolveType === "string" &&
                isSeoSectionResolveType(seoObj.__resolveType)
              ? seoObj.__resolveType
              : DEFAULT_SEO_RESOLVE_TYPE,
        };
      }
    }
  }

  // 2) Standalone SEO block.
  for (const [key, val] of Object.entries(decofile)) {
    if (!isPlainObject(val)) continue;
    const obj = val;
    if (
      typeof obj.__resolveType === "string" &&
      isSeoSectionResolveType(obj.__resolveType)
    ) {
      return {
        blockKey: key,
        kind: "block",
        seoData: obj,
        blockData: obj,
        seoResolveType: obj.__resolveType,
      };
    }
  }
  return null;
}

/** Builds the decofile block payload to persist an edited site-SEO value. */
export function buildSiteSeoBlockData(
  entry: SiteSeoEntry,
  value: Record<string, unknown>,
): Record<string, unknown> {
  return entry.kind === "block" ? value : { ...entry.blockData, seo: value };
}

/** What a SEO surface is editing: a specific page, or the site default. */
export type SeoTarget =
  | { kind: "page"; pageKey: string; pageName: string; path: string }
  | { kind: "site" };

export interface ResolvedSeo {
  blockKey: string;
  /** Inner SEO config (lazy wrapper stripped). Undefined when SEO is disabled. */
  seoData: Record<string, unknown> | undefined;
  /** Full `page.seo` as stored — may be lazy-wrapped. */
  rawSeoData?: unknown;
  /** resolveType to resolve the form schema with. */
  seoResolveType: string;
  /** Site target only: how SEO is stored on the owning block. */
  siteKind?: "block" | "nested";
  /** SEO variants from the live schema (when `meta` is passed). */
  seoTypeOptions?: SeoTypeOption[];
  /** Builds the full decofile block payload to persist an edited SEO value. */
  build: (value: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Resolves the SEO block + write target for a page or the site default. Shared
 * by every SEO surface (the two-pane editor and the sheets) so they all read
 * and persist SEO the same way. Returns null when no SEO block exists.
 */
export function resolveSeoTarget(
  decofile: Record<string, unknown>,
  target: SeoTarget,
  meta?: LiveMeta,
): ResolvedSeo | null {
  if (target.kind === "site") {
    const entry = findSiteSeoEntry(decofile, meta);
    if (!entry) return null;
    return {
      blockKey: entry.blockKey,
      seoData: entry.seoData,
      seoResolveType: entry.seoResolveType,
      siteKind: entry.kind,
      seoTypeOptions: meta
        ? listSiteSeoTypeOptions(meta, entry.blockData)
        : undefined,
      build: (value) => buildSiteSeoBlockData(entry, value),
    };
  }
  // Guard against malformed entries: a non-object page block (or a non-object
  // `seo`) would otherwise be spread into the saved payload and corrupt it.
  const rawBlock = decofile[target.pageKey];
  if (!isPlainObject(rawBlock)) return null;
  const blockData = rawBlock;
  const rawSeo = blockData.seo;
  const innerSeo = unwrapSeoConfig(rawSeo);
  const innerRecord =
    innerSeo && isPlainObject(innerSeo) ? innerSeo : undefined;
  return {
    blockKey: target.pageKey,
    seoData: innerRecord,
    rawSeoData: rawSeo,
    seoResolveType: meta
      ? resolvePageSeoResolveType(meta, innerRecord)
      : typeof innerRecord?.__resolveType === "string"
        ? innerRecord.__resolveType
        : DEFAULT_SEO_RESOLVE_TYPE,
    seoTypeOptions: meta ? listPageSeoTypeOptions(meta) : undefined,
    build: (value) => ({
      ...blockData,
      seo: value === null ? null : wrapSeoPersistValue(value, rawSeo),
    }),
  };
}
