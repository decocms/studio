import { isLazyResolveType } from "./section-lazy";

export const LAZY_RENDER_RESOLVE_TYPE = "website/sections/Rendering/Lazy.tsx";

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

export interface SeoLazyWrapper {
  __resolveType: string;
  section?: Record<string, unknown> | null;
}

/** True when `page.seo` is wrapped in Lazy / SingleDeferred (admin async render). */
export function isSeoLazyRender(raw: unknown): raw is SeoLazyWrapper {
  if (!isPlainObject(raw)) return false;
  const rt = raw.__resolveType;
  return typeof rt === "string" && isLazyResolveType(rt);
}

export function isSeoEnabled(raw: unknown): boolean {
  return raw !== null && raw !== undefined;
}

/** Inner SEO config for the form — unwraps lazy wrapper when present. */
export function unwrapSeoConfig(
  raw: unknown,
): Record<string, unknown> | null | undefined {
  if (raw === null || raw === undefined) return raw;
  if (isSeoLazyRender(raw)) {
    const section = raw.section;
    if (section === null || section === undefined) return null;
    return isPlainObject(section) ? section : {};
  }
  return isPlainObject(raw) ? raw : undefined;
}

/** Writes inner SEO edits back onto `page.seo`, preserving lazy wrapper when set. */
export function wrapSeoPersistValue(
  inner: Record<string, unknown> | null,
  rawSeo: unknown,
): Record<string, unknown> | null {
  if (inner === null) return null;
  if (isSeoLazyRender(rawSeo)) {
    return { ...rawSeo, section: inner };
  }
  return inner;
}

export function defaultEnabledSeo(
  defaultResolveType: string,
): Record<string, unknown> {
  return { __resolveType: defaultResolveType };
}

/** Wrap or unwrap lazy render on the full `page.seo` value (admin parity). */
export function toggleSeoAsyncRender(
  enabled: boolean,
  rawSeo: unknown,
): Record<string, unknown> | null {
  if (!isSeoEnabled(rawSeo)) return null;
  if (enabled) {
    const inner = unwrapSeoConfig(rawSeo) ?? {};
    return {
      __resolveType: LAZY_RENDER_RESOLVE_TYPE,
      section: inner,
    };
  }
  if (isSeoLazyRender(rawSeo)) {
    return unwrapSeoConfig(rawSeo) ?? null;
  }
  return isPlainObject(rawSeo) ? rawSeo : null;
}
