import type { ParsedSection } from "./parse-sections";
import { isLazyResolveType, LAZY_RENDER_RESOLVE_TYPE } from "./section-lazy";
import {
  defaultVariantRule,
  NEVER_MATCHER_RESOLVE_TYPE,
  SECTION_MULTIVARIATE_RESOLVE_TYPE,
  type RawSection,
} from "./section-types";

export type { RawSection };

// Lazy (Lazy.tsx) and hidden (multivariate + never matcher) are mutually exclusive
// wrappers — a section may have one or the other, never both nested together.

/** Strip a top-level Lazy / SingleDeferred wrapper when present. */
function unwrapLazySection(raw: RawSection): RawSection {
  const rt = raw.__resolveType ?? "";
  if (isLazyResolveType(rt)) {
    return (raw.section as RawSection | undefined) ?? raw;
  }
  return raw;
}

function readHiddenNeverVariantValue(raw: RawSection): RawSection | null {
  const outerLazy = isLazyResolveType(raw.__resolveType ?? "");
  const mvObj = (outerLazy ? raw.section : raw) as
    | Record<string, unknown>
    | undefined;
  const variants = mvObj?.variants as
    | Array<Record<string, unknown>>
    | undefined;
  const first = variants?.[0];
  const rule = first?.rule as Record<string, unknown> | undefined;
  if (
    (rule?.__resolveType as string | undefined) !== NEVER_MATCHER_RESOLVE_TYPE
  ) {
    return null;
  }
  return (first?.value as RawSection | undefined) ?? null;
}

/**
 * Wrap a section in a multivariate block gated by a `never` matcher so it never
 * renders on the live site. Parses back as `isHidden`.
 *
 * Lazy and hidden are mutually exclusive — hiding unwraps lazy first so the
 * stored variant value is always the core section.
 */
export function hideSection(raw: RawSection): RawSection {
  const core = unwrapLazySection(raw);
  return {
    __resolveType: SECTION_MULTIVARIATE_RESOLVE_TYPE,
    variants: [
      { value: core, rule: { __resolveType: NEVER_MATCHER_RESOLVE_TYPE } },
    ],
  } as RawSection;
}

/**
 * Toggle `website/sections/Rendering/Lazy.tsx` on a page section.
 *
 * Lazy and hidden are mutually exclusive — enabling lazy on a hidden section
 * drops the never-matcher wrapper and lazy-wraps the core section instead.
 */
export function toggleSectionLazyRender(raw: RawSection): RawSection | null {
  const rt = raw.__resolveType ?? "";
  if (!rt) return null;

  if (isLazyResolveType(rt)) {
    return (raw.section as RawSection | undefined) ?? null;
  }

  const hiddenInner = readHiddenNeverVariantValue(raw);
  if (hiddenInner) {
    // Legacy multivariate(never(lazy(core))) — drop hidden, keep existing lazy shell.
    if (isLazyResolveType(hiddenInner.__resolveType ?? "")) {
      return hiddenInner;
    }
    return {
      __resolveType: LAZY_RENDER_RESOLVE_TYPE,
      section: unwrapLazySection(hiddenInner),
    };
  }

  return {
    __resolveType: LAZY_RENDER_RESOLVE_TYPE,
    section: raw,
  };
}

export interface SectionPreviewContext {
  resolveType: string;
  data: Record<string, unknown>;
}

function resolveCoreSectionContent(
  section: RawSection,
): SectionPreviewContext | null {
  const rt = section.__resolveType ?? "";
  if (!rt) return null;

  if (isLazyResolveType(rt)) {
    const nested = section.section as Record<string, unknown> | undefined;
    const resolveType = (nested?.__resolveType as string) ?? "";
    if (!resolveType || !nested) return null;
    return { resolveType, data: nested };
  }

  return { resolveType: rt, data: section as Record<string, unknown> };
}

/** Resolve inner section content for list thumbnails (lazy/hidden/legacy shapes). */
export function resolveSectionPreviewContext(
  raw: RawSection,
): SectionPreviewContext | null {
  const hiddenInner = readHiddenNeverVariantValue(raw);
  if (hiddenInner) {
    return resolveCoreSectionContent(hiddenInner);
  }

  const outerLazy = isLazyResolveType(raw.__resolveType ?? "");
  if (outerLazy) {
    const inner = raw.section as RawSection | undefined;
    if (!inner) return null;

    const hiddenInLazy = readHiddenNeverVariantValue(inner);
    if (hiddenInLazy) {
      return resolveCoreSectionContent(hiddenInLazy);
    }
    return resolveCoreSectionContent(inner);
  }

  return resolveCoreSectionContent(raw);
}

/** Unwrap a hidden section back to the section it was hiding, or null. */
export function showSection(raw: RawSection): RawSection | null {
  return readHiddenNeverVariantValue(raw);
}

export interface SectionFlagVariant {
  label: string;
  value: Record<string, unknown>;
  rule?: Record<string, unknown>;
}

const DEFAULT_MATCHER_TYPES = [
  "website/matchers/always.ts",
  "$live/matchers/MatchAlways.ts",
];

export function isDefaultVariantRule(rule?: Record<string, unknown>): boolean {
  if (!rule) return false;
  const rt = (rule.__resolveType as string) ?? "";
  if (rt === "") return Object.keys(rule).length === 0;
  return DEFAULT_MATCHER_TYPES.includes(rt) || rt.includes("always");
}

export function pickVariantToKeepIndex(mvObj: Record<string, unknown>): number {
  const variants = (mvObj.variants as Array<Record<string, unknown>>) ?? [];
  if (variants.length === 0) return -1;

  const defaultIndex = variants.findIndex((variant) =>
    isDefaultVariantRule(variant.rule as Record<string, unknown> | undefined),
  );
  if (defaultIndex !== -1) return defaultIndex;
  return variants.length - 1;
}

export function flattenMultivariateSection(
  raw: RawSection,
  parsed: { isLazy?: boolean },
  mvObj: Record<string, unknown>,
): RawSection | null {
  const variants = (mvObj.variants as Array<Record<string, unknown>>) ?? [];
  if (variants.length === 0) return null;

  const keepIndex = pickVariantToKeepIndex(mvObj);
  const keptValue = variants[keepIndex]?.value as
    | Record<string, unknown>
    | undefined;
  if (!keptValue) return null;

  const nextValue = structuredClone(keptValue);

  if (parsed.isLazy) {
    return {
      ...raw,
      section: nextValue,
    } as RawSection;
  }

  return nextValue as RawSection;
}

export function getMultivariateSectionObject(
  raw: RawSection,
  parsed: { isLazy?: boolean; isMultivariate?: boolean },
): Record<string, unknown> | null {
  if (!parsed.isMultivariate) return null;
  if (parsed.isLazy) {
    const inner = raw.section as Record<string, unknown> | undefined;
    return inner ?? null;
  }
  return raw as Record<string, unknown>;
}

export function parseSectionFlagVariants(
  mvObj: Record<string, unknown>,
  formatMatcher: (rule?: Record<string, unknown>) => string,
): SectionFlagVariant[] {
  if (!Array.isArray(mvObj.variants)) return [];

  return (mvObj.variants as Array<Record<string, unknown>>).map(
    (variant, index) => ({
      label:
        formatMatcher(variant.rule as Record<string, unknown> | undefined) ||
        `Variant ${index + 1}`,
      value: (variant.value ?? {}) as Record<string, unknown>,
      rule: variant.rule as Record<string, unknown> | undefined,
    }),
  );
}

export function unwrapVariantSectionValue(
  value: Record<string, unknown>,
  decofile: Record<string, unknown>,
): { data: Record<string, unknown>; resolveType: string } | null {
  const rt = (value.__resolveType as string) ?? "";
  if (!rt) return null;

  if (isLazyResolveType(rt)) {
    const inner = (value.section as Record<string, unknown>) ?? value;
    const innerRt = (inner.__resolveType as string) ?? rt;

    if (!innerRt.includes("/") && innerRt in decofile) {
      const blockData = (decofile[innerRt] as Record<string, unknown>) ?? {};
      return {
        data: { ...blockData },
        resolveType: (blockData.__resolveType as string) ?? innerRt,
      };
    }

    return {
      data: { ...inner },
      resolveType: innerRt,
    };
  }

  if (!rt.includes("/") && rt in decofile) {
    const blockData = (decofile[rt] as Record<string, unknown>) ?? {};
    return {
      data: { ...blockData },
      resolveType: (blockData.__resolveType as string) ?? rt,
    };
  }

  return {
    data: { ...value },
    resolveType: rt,
  };
}

export function writeVariantSectionValue(
  originalValue: Record<string, unknown>,
  nextValue: Record<string, unknown>,
): Record<string, unknown> {
  const rt = (originalValue.__resolveType as string) ?? "";
  if (isLazyResolveType(rt)) {
    return {
      ...originalValue,
      section: nextValue,
    };
  }
  return nextValue;
}

export function rebuildSectionWithMultivariate(
  raw: RawSection,
  parsed: { isLazy?: boolean },
  mvObj: Record<string, unknown>,
): RawSection {
  if (parsed.isLazy) {
    return {
      ...raw,
      section: mvObj,
    } as RawSection;
  }
  return mvObj as RawSection;
}

export function updateMultivariateSectionVariantValue(
  mvObj: Record<string, unknown>,
  variantIndex: number,
  nextValue: Record<string, unknown>,
): Record<string, unknown> {
  const variants = [
    ...((mvObj.variants as Array<Record<string, unknown>>) ?? []),
  ];
  const currentVariant = variants[variantIndex];
  if (!currentVariant) return mvObj;

  const originalValue = (currentVariant.value ?? {}) as Record<string, unknown>;
  variants[variantIndex] = {
    ...currentVariant,
    value: writeVariantSectionValue(originalValue, nextValue),
  };

  return { ...mvObj, variants };
}

export function updateMultivariateSectionVariantRule(
  mvObj: Record<string, unknown>,
  variantIndex: number,
  nextRule: Record<string, unknown>,
): Record<string, unknown> {
  const variants = [
    ...((mvObj.variants as Array<Record<string, unknown>>) ?? []),
  ];
  if (!variants[variantIndex]) return mvObj;

  variants[variantIndex] = {
    ...variants[variantIndex],
    rule: nextRule,
  };

  return { ...mvObj, variants };
}

export function duplicateMultivariateSectionVariant(
  mvObj: Record<string, unknown>,
  variantIndex: number,
): Record<string, unknown> {
  const variants = [
    ...((mvObj.variants as Array<Record<string, unknown>>) ?? []),
  ];
  const source = variants[variantIndex];
  if (!source) return mvObj;

  variants.splice(variantIndex + 1, 0, structuredClone(source));
  return { ...mvObj, variants };
}

export function reorderMultivariateSectionVariant(
  mvObj: Record<string, unknown>,
  fromIndex: number,
  toIndex: number,
): Record<string, unknown> {
  const variants = [
    ...((mvObj.variants as Array<Record<string, unknown>>) ?? []),
  ];
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= variants.length ||
    toIndex >= variants.length
  ) {
    return mvObj;
  }

  const [moved] = variants.splice(fromIndex, 1);
  if (!moved) return mvObj;
  variants.splice(toIndex, 0, moved);
  return { ...mvObj, variants };
}

export function deleteMultivariateSectionVariant(
  mvObj: Record<string, unknown>,
  variantIndex: number,
): Record<string, unknown> | null {
  const variants = [
    ...((mvObj.variants as Array<Record<string, unknown>>) ?? []),
  ];
  if (variants.length <= 1) return null;

  variants.splice(variantIndex, 1);
  return { ...mvObj, variants };
}

function createSectionVariantEntry(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    rule: defaultVariantRule(),
    value: structuredClone(value),
  };
}

function createMultivariateSectionObject(
  variants: Array<Record<string, unknown>>,
  existing?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...existing,
    __resolveType: SECTION_MULTIVARIATE_RESOLVE_TYPE,
    variants,
  };
}

/** Whether a section can be converted to (or extended with) variants. */
export function canAddSectionVariant(section: {
  isHidden?: boolean;
  isSavedBlock?: boolean;
}): boolean {
  return section.isHidden !== true && section.isSavedBlock !== true;
}

/** Extract the variant payload from a raw section for wrapping or seeding. */
function extractSectionVariantSeed(
  raw: RawSection,
  parsed: ParsedSection,
): Record<string, unknown> | null {
  if (parsed.isHidden) return null;

  if (parsed.isMultivariate) {
    const mvObj = getMultivariateSectionObject(raw, parsed);
    const variants = (mvObj?.variants as Array<Record<string, unknown>>) ?? [];
    const last = variants[variants.length - 1]?.value as
      | Record<string, unknown>
      | undefined;
    return last ? structuredClone(last) : null;
  }

  if (parsed.isLazy) {
    const inner = raw.section as Record<string, unknown> | undefined;
    return inner ? structuredClone(inner) : null;
  }

  return structuredClone(raw) as Record<string, unknown>;
}

/**
 * Wrap a plain or lazy section in a multivariate block with two variants
 * (original + clone). Returns null for hidden or unsupported shapes.
 */
function wrapSectionAsMultivariate(
  raw: RawSection,
  parsed: ParsedSection,
  seedValue?: Record<string, unknown>,
): RawSection | null {
  if (parsed.isMultivariate || parsed.isHidden) return null;

  const seed = seedValue ?? extractSectionVariantSeed(raw, parsed);
  if (!seed) return null;

  const mvObj = createMultivariateSectionObject([
    createSectionVariantEntry(seed),
    createSectionVariantEntry(seed),
  ]);

  if (parsed.isLazy) {
    return {
      ...raw,
      section: mvObj,
    } as RawSection;
  }

  return mvObj as RawSection;
}

/**
 * Append a section variant. Wraps plain/lazy sections on first use; extends
 * existing multivariate sections. Returns null when the shape cannot be extended.
 */
export function appendSectionVariant(
  raw: RawSection,
  parsed: ParsedSection,
  seedValue?: Record<string, unknown>,
): { section: RawSection; newVariantIndex: number } | null {
  if (parsed.isHidden || parsed.isSavedBlock) return null;

  if (parsed.isMultivariate) {
    const mvObj = getMultivariateSectionObject(raw, parsed);
    if (!mvObj) return null;

    const variants = (mvObj.variants as Array<Record<string, unknown>>) ?? [];
    const seed =
      seedValue ??
      (variants[variants.length - 1]?.value as
        | Record<string, unknown>
        | undefined);
    if (!seed) return null;

    const updatedMvObj = createMultivariateSectionObject(
      [...variants, createSectionVariantEntry(seed)],
      mvObj,
    );
    return {
      section: rebuildSectionWithMultivariate(raw, parsed, updatedMvObj),
      newVariantIndex: variants.length,
    };
  }

  const wrapped = wrapSectionAsMultivariate(raw, parsed, seedValue);
  if (!wrapped) return null;
  return { section: wrapped, newVariantIndex: 1 };
}
