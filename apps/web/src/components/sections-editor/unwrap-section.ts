import { isSavedBlockResolveType } from "./block-type-utils";
import { isLazyResolveType } from "./section-lazy";
import type { ParsedSection } from "./parse-sections";
import type { RawSection } from "./section-types";
import { isMultivariateResolveType, readVariantValue } from "./variant-shape";

function resolveSavedBlockData(
  blockKey: string,
  decofile: Record<string, unknown>,
): { data: Record<string, unknown>; resolveType: string } | null {
  if (!Object.hasOwn(decofile, blockKey)) return null;
  const blockData = (decofile[blockKey] as Record<string, unknown>) ?? {};
  const rt = (blockData.__resolveType as string) ?? blockKey;
  return { data: { ...blockData }, resolveType: rt };
}

function unwrapResolvedValue(
  rt: string,
  value: Record<string, unknown>,
  decofile: Record<string, unknown>,
): { data: Record<string, unknown>; resolveType: string } | null {
  if (!rt) return null;

  if (isMultivariateResolveType(rt)) {
    const firstVariant = readVariantValue(
      (value.variants as unknown[] | undefined)?.[0],
    ) as Record<string, unknown> | undefined;
    if (!firstVariant) return null;
    return unwrapSectionValue(firstVariant, decofile);
  }

  if (!isSavedBlockResolveType(rt) || !Object.hasOwn(decofile, rt)) {
    return { data: { ...value }, resolveType: rt };
  }
  return resolveSavedBlockData(rt, decofile);
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

  return unwrapResolvedValue(rt, value, decofile);
}

function unwrapLazyInner(
  inner: Record<string, unknown>,
  decofile: Record<string, unknown>,
): { data: Record<string, unknown>; resolveType: string } | null {
  const innerRt = (inner.__resolveType as string) ?? "";
  return unwrapResolvedValue(innerRt, inner, decofile);
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
 * The decofile key a saved-block section writes back to. For a hidden saved
 * block, `raw.__resolveType` is the multivariate+never wrapper, not the block
 * key — the real key lives in the wrapped variant value. Returns null when the
 * section isn't a saved block.
 */
export function savedBlockKey(
  raw: RawSection,
  parsed: ParsedSection,
): string | null {
  if (!parsed.isSavedBlock) return null;

  if (parsed.isHidden) {
    const wrapperIsLazy = isLazyResolveType(raw.__resolveType);
    const mvObj = wrapperIsLazy ? (raw.section as RawSection | undefined) : raw;
    const innerValue = readVariantValue(mvObj?.variants?.[0]) as
      | Record<string, unknown>
      | undefined;
    if (!innerValue) return null;
    const innerRt = (innerValue.__resolveType as string) ?? "";
    if (!isLazyResolveType(innerRt)) return innerRt || null;
    return (
      ((innerValue.section as Record<string, unknown> | undefined)
        ?.__resolveType as string) ??
      innerRt ??
      null
    );
  }

  const key = parsed.isLazy
    ? ((raw.section?.__resolveType as string) ?? raw.__resolveType)
    : raw.__resolveType;
  return key || null;
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

  if (parsed.isSavedBlock && !parsed.isHidden) {
    const blockKey = parsed.isLazy
      ? ((raw.section?.__resolveType as string) ?? raw.__resolveType)
      : raw.__resolveType;
    return resolveSavedBlockData(blockKey, decofile);
  }

  // Hidden checked before isSavedBlock: a hidden section's raw.__resolveType is the never-matcher wrapper, not the block key.
  if (parsed.isHidden) {
    const isLazy = isLazyResolveType(raw.__resolveType);
    const mvObj = isLazy ? (raw.section as RawSection | undefined) : raw;
    const innerValue =
      (readVariantValue(mvObj?.variants?.[0]) as
        | Record<string, unknown>
        | undefined) ?? (raw as Record<string, unknown>);
    const innerRt = (innerValue.__resolveType as string) ?? "";
    const effectiveInnerRt = isLazyResolveType(innerRt)
      ? (((innerValue.section as Record<string, unknown> | undefined)
          ?.__resolveType as string) ?? innerRt)
      : innerRt;
    // Hidden variant section wraps a multivariate block; editing it as one section would flatten the variants.
    if (isMultivariateResolveType(effectiveInnerRt)) {
      return null;
    }
    return unwrapSectionValue(innerValue, decofile);
  }

  if (parsed.isLazy || isLazyResolveType(raw.__resolveType)) {
    const inner = (raw.section as Record<string, unknown>) ?? {};
    return unwrapLazyInner(inner, decofile);
  }

  return unwrapSectionValue(raw as Record<string, unknown>, decofile);
}
