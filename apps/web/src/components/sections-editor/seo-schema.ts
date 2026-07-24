import { isSavedBlockResolveType } from "./block-type-utils";
import {
  collectAnyOfRefsFromSchema,
  findLivePageResolveType,
} from "./section-catalog";
import {
  resolveSchema,
  type LiveMeta,
  type SchemaProperty,
} from "./resolve-schema";
import { DEFAULT_SEO_RESOLVE_TYPE } from "./seo-block";

/** Admin's `SEO_OPTION` label for `website/sections/Seo/SeoV2.tsx`. */
const DEFAULT_SEO_TYPE_LABEL = "General";

export interface SeoTypeOption {
  resolveType: string;
  title: string;
  description?: string;
}

/** Matches SEO section resolveTypes, e.g. "website/sections/Seo/SeoV2.tsx". */
export function isSeoSectionResolveType(resolveType: string): boolean {
  return (
    /\/Seo(V\d+)?\.tsx$/i.test(resolveType) ||
    resolveType.includes("/sections/Seo")
  );
}

function seoTypeLabel(resolveType: string, title: string): string {
  if (resolveType === DEFAULT_SEO_RESOLVE_TYPE) return DEFAULT_SEO_TYPE_LABEL;
  return title;
}

function seoOptionsFromPropertySchema(
  schema: SchemaProperty | null | undefined,
): SeoTypeOption[] {
  const refs = collectAnyOfRefsFromSchema(schema);
  const seen = new Set<string>();
  const options: SeoTypeOption[] = [];
  for (const ref of refs) {
    if (!isSeoSectionResolveType(ref.resolveType)) continue;
    if (isSavedBlockResolveType(ref.resolveType)) continue;
    if (seen.has(ref.resolveType)) continue;
    seen.add(ref.resolveType);
    options.push({
      resolveType: ref.resolveType,
      title: seoTypeLabel(ref.resolveType, ref.title),
      description: ref.description,
    });
  }
  return options;
}

/**
 * Lists valid page-level SEO section types from the live page schema's `seo`
 * property (JSON Schema anyOf), mirroring admin's `getAllPageSeoSectionSchemas`.
 */
export function listPageSeoTypeOptions(meta: LiveMeta): SeoTypeOption[] {
  const pageRt = findLivePageResolveType(meta);
  const pageSchema = resolveSchema(pageRt, meta);
  const fromPage = seoOptionsFromPropertySchema(pageSchema?.properties?.seo);
  if (fromPage.length > 0) return fromPage;

  return listManifestSeoSectionOptions(meta);
}

/** SEO section types declared in the manifest when the page schema has no `seo` union. */
function listManifestSeoSectionOptions(meta: LiveMeta): SeoTypeOption[] {
  const blocks = meta.manifest?.blocks ?? {};
  const options: SeoTypeOption[] = [];
  for (const [blockType, blockMap] of Object.entries(blocks)) {
    if (!blockType.includes("sections")) continue;
    for (const resolveType of Object.keys(blockMap)) {
      if (!isSeoSectionResolveType(resolveType)) continue;
      const shortTitle =
        resolveType
          .split("/")
          .pop()
          ?.replace(/\.tsx?$/, "") ?? resolveType;
      options.push({
        resolveType,
        title: seoTypeLabel(resolveType, shortTitle),
      });
    }
  }
  return options;
}

/**
 * Default page SEO type: prefer SeoV2 when the schema allows it (admin's
 * `SEO_OPTION`), otherwise the first schema-listed SEO variant.
 */
export function defaultPageSeoResolveType(meta: LiveMeta): string {
  const options = listPageSeoTypeOptions(meta);
  const preferred = options.find(
    (o) => o.resolveType === DEFAULT_SEO_RESOLVE_TYPE,
  );
  if (preferred) return preferred.resolveType;
  return options[0]?.resolveType ?? DEFAULT_SEO_RESOLVE_TYPE;
}

/**
 * Lists SEO types allowed on the site config's `seo` prop (site app schema),
 * falling back to page SEO options when the site schema has no union.
 */
export function listSiteSeoTypeOptions(
  meta: LiveMeta,
  siteBlockData: Record<string, unknown>,
): SeoTypeOption[] {
  const siteRt = siteBlockData.__resolveType;
  if (typeof siteRt === "string") {
    const siteSchema = resolveSchema(siteRt, meta);
    const fromSite = seoOptionsFromPropertySchema(siteSchema?.properties?.seo);
    if (fromSite.length > 0) return fromSite;
  }
  return listPageSeoTypeOptions(meta);
}

export function defaultSiteSeoResolveType(
  meta: LiveMeta,
  siteBlockData: Record<string, unknown>,
): string {
  const options = listSiteSeoTypeOptions(meta, siteBlockData);
  const preferred = options.find(
    (o) => o.resolveType === DEFAULT_SEO_RESOLVE_TYPE,
  );
  if (preferred) return preferred.resolveType;
  return options[0]?.resolveType ?? defaultPageSeoResolveType(meta);
}

/** Resolve type for `page.seo` form schema — data wins, then manifest default. */
export function resolvePageSeoResolveType(
  meta: LiveMeta,
  seoData: Record<string, unknown> | undefined,
): string {
  const rt = seoData?.__resolveType;
  if (typeof rt === "string" && rt.length > 0) return rt;
  return defaultPageSeoResolveType(meta);
}

/** Resolve type for site/default SEO when props may be inlined without `__resolveType`. */
export function resolveSiteSeoResolveType(
  meta: LiveMeta,
  siteBlockData: Record<string, unknown>,
  seoData: Record<string, unknown>,
): string {
  const rt = seoData.__resolveType;
  if (typeof rt === "string" && isSeoSectionResolveType(rt)) return rt;
  return defaultSiteSeoResolveType(meta, siteBlockData);
}
