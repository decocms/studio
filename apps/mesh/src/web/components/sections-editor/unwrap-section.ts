import { isSavedBlockResolveType } from "./block-type-utils";
import { isLazyResolveType } from "./section-lazy";
import type { ParsedSection } from "./parse-sections";
import {
  PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
  SECTION_MULTIVARIATE_RESOLVE_TYPE,
  type RawSection,
} from "./section-types";

function isMultivariateResolveType(rt: string): boolean {
  return (
    rt === SECTION_MULTIVARIATE_RESOLVE_TYPE ||
    rt === PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE
  );
}

function resolveSavedBlockData(
  blockKey: string,
  decofile: Record<string, unknown>,
): { data: Record<string, unknown>; resolveType: string } | null {
  if (!Object.hasOwn(decofile, blockKey)) return null;
  const blockData = (decofile[blockKey] as Record<string, unknown>) ?? {};
  const rt = (blockData.__resolveType as string) ?? blockKey;
  return { data: { ...blockData }, resolveType: rt };
}

function unwrapSectionValue(
  value: Record<string, unknown>,
  decofile: Record<string, unknown>,
): { data: Record<string, unknown>; resolveType: string } | null {
  const rt = (value.__resolveType as string) ?? "";
  if (!rt) return null;

  if (isLazyResolveType(rt)) {
    const inner = (value.section as Record<string, unknown>) ?? {};
    return unwrapLazyInner(inner, decofile);
  }

  if (isMultivariateResolveType(rt)) {
    const firstVariant = (
      value.variants as Array<{ value?: Record<string, unknown> }> | undefined
    )?.[0]?.value;
    if (!firstVariant) return null;
    return unwrapSectionValue(firstVariant, decofile);
  }

  if (!isSavedBlockResolveType(rt) || !Object.hasOwn(decofile, rt)) {
    return { data: { ...value }, resolveType: rt };
  }
  return resolveSavedBlockData(rt, decofile);
}

function unwrapLazyInner(
  inner: Record<string, unknown>,
  decofile: Record<string, unknown>,
): { data: Record<string, unknown>; resolveType: string } | null {
  const innerRt = (inner.__resolveType as string) ?? "";
  if (!innerRt) return null;

  if (isMultivariateResolveType(innerRt)) {
    const firstVariant = (
      inner.variants as Array<{ value?: Record<string, unknown> }> | undefined
    )?.[0]?.value;
    if (!firstVariant) return null;
    return unwrapSectionValue(firstVariant, decofile);
  }

  if (!isSavedBlockResolveType(innerRt) || !Object.hasOwn(decofile, innerRt)) {
    return { data: { ...inner }, resolveType: innerRt };
  }
  return resolveSavedBlockData(innerRt, decofile);
}

/**
 * When a field value is a saved-block pointer (`{ __resolveType: "Deco" }`),
 * load the referenced decofile entry for editing (site theme, global sections, …).
 */
export function unwrapBlockReference(
  value: unknown,
  decofile: Record<string, unknown>,
): {
  blockKey: string;
  data: Record<string, unknown>;
  resolveType: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const blockKey = obj.__resolveType;
  if (typeof blockKey !== "string" || !isSavedBlockResolveType(blockKey)) {
    return null;
  }
  if (!Object.hasOwn(decofile, blockKey)) return null;
  const resolved = resolveSavedBlockData(blockKey, decofile);
  return resolved ? { blockKey, ...resolved } : null;
}

/**
 * Unwrap a raw section to get the actual editable data and its resolveType.
 * Handles lazy wrappers, hidden (multivariate+never), saved blocks, and
 * multivariate sections — mirrors admin-mcp's handleCmsSelectSection.
 */
export function unwrapSection(
  raw: RawSection,
  parsed: ParsedSection,
  decofile: Record<string, unknown>,
): { data: Record<string, unknown>; resolveType: string } | null {
  if (parsed.isMultivariate) {
    return null;
  }

  if (parsed.isSavedBlock) {
    const blockKey = parsed.isLazy
      ? ((raw.section?.__resolveType as string) ?? raw.__resolveType)
      : raw.__resolveType;
    return resolveSavedBlockData(blockKey, decofile);
  }

  if (parsed.isHidden) {
    const isLazy = isLazyResolveType(raw.__resolveType);
    const mvObj = isLazy ? (raw.section as RawSection | undefined) : raw;
    const innerValue =
      (mvObj?.variants?.[0]?.value as Record<string, unknown>) ??
      (raw as Record<string, unknown>);
    return unwrapSectionValue(innerValue, decofile);
  }

  if (parsed.isLazy || isLazyResolveType(raw.__resolveType)) {
    const inner = (raw.section as Record<string, unknown>) ?? {};
    return unwrapLazyInner(inner, decofile);
  }

  return unwrapSectionValue(raw as Record<string, unknown>, decofile);
}
