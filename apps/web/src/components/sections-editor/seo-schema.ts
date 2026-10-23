import { isSavedBlockResolveType } from "./block-type-utils";
import {
  collectAnyOfRefsFromSchema,
  declaresBuiltInPage,
  findNewPageResolveType,
} from "./section-catalog";
import { isLazyResolveType } from "./section-lazy";
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

/** v7 SEO section file names, e.g. "website/sections/Seo/SeoV2.tsx". */
function isV7SeoFileName(resolveType: string): boolean {
  return (
    /\/Seo(V\d+)?\.tsx$/i.test(resolveType) ||
    resolveType.includes("/sections/Seo")
  );
}

/**
 * Whether a type is an SEO type. On a next-major site (it declares the
 * built-in `page`) that is any type its page schema's `seo` union lists,
 * whatever it is named; v7 page schemas type `seo` as any section, so there
 * (and without `meta`) only the v7 SEO file names count.
 */
export function isSeoSectionResolveType(
  resolveType: string,
  meta?: LiveMeta,
): boolean {
  if (isV7SeoFileName(resolveType)) return true;
  if (!meta || !declaresBuiltInPage(meta)) return false;
  return listPageSeoTypeOptions(meta).some(
    (o) => o.resolveType === resolveType,
  );
}

function seoTypeLabel(resolveType: string, title: string): string {
  if (resolveType === DEFAULT_SEO_RESOLVE_TYPE) return DEFAULT_SEO_TYPE_LABEL;
  return title;
}

function seoOptionsFromPropertySchema(
  schema: SchemaProperty | null | undefined,
  meta: LiveMeta,
): SeoTypeOption[] {
  const refs = collectAnyOfRefsFromSchema(schema);
  // Next-major's `seo` union lists exactly the SEO types; v7's lists every
  // section, so it is narrowed to the SEO file names.
  const unionIsSeoOnly = declaresBuiltInPage(meta);
  const seen = new Set<string>();
  const options: SeoTypeOption[] = [];
  for (const ref of refs) {
    if (unionIsSeoOnly) {
      if (isLazyResolveType(ref.resolveType)) continue;
    } else if (!isV7SeoFileName(ref.resolveType)) continue;
    if (isSavedBlockResolveType(ref.resolveType, meta)) continue;
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
  const pageRt = findNewPageResolveType(meta);
  const pageSchema = resolveSchema(pageRt, meta);
  const fromPage = seoOptionsFromPropertySchema(
    pageSchema?.properties?.seo,
    meta,
  );
  if (fromPage.length > 0) return fromPage;
  // Next-major: the page schema is the whole answer — no `seo` union, no SEO.
  if (declaresBuiltInPage(meta)) return [];

  return listManifestSeoSectionOptions(meta);
}

/** SEO section types declared in the manifest when the page schema has no `seo` union. */
function listManifestSeoSectionOptions(meta: LiveMeta): SeoTypeOption[] {
  const blocks = meta.manifest?.blocks ?? {};
  const options: SeoTypeOption[] = [];
  for (const [blockType, blockMap] of Object.entries(blocks)) {
    if (!blockType.includes("sections")) continue;
    for (const resolveType of Object.keys(blockMap)) {
      if (!isV7SeoFileName(resolveType)) continue;
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
 * `SEO_OPTION`), otherwise the first schema-listed SEO variant. A v7 site
 * falls back to SeoV2; a next-major site whose page schema lists no SEO type
 * has none (`""`).
 */
export function defaultPageSeoResolveType(meta: LiveMeta): string {
  const options = listPageSeoTypeOptions(meta);
  const preferred = options.find(
    (o) => o.resolveType === DEFAULT_SEO_RESOLVE_TYPE,
  );
  if (preferred) return preferred.resolveType;
  const fallback = declaresBuiltInPage(meta) ? "" : DEFAULT_SEO_RESOLVE_TYPE;
  return options[0]?.resolveType ?? fallback;
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
    const fromSite = seoOptionsFromPropertySchema(
      siteSchema?.properties?.seo,
      meta,
    );
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
  if (typeof rt === "string" && isSeoSectionResolveType(rt, meta)) return rt;
  return defaultSiteSeoResolveType(meta, siteBlockData);
}
