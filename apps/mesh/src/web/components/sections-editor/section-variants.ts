import { isLazyResolveType } from "./section-lazy";
import {
  NEVER_MATCHER_RESOLVE_TYPE,
  SECTION_MULTIVARIATE_RESOLVE_TYPE,
  type RawSection,
} from "./section-types";

export type { RawSection };

/**
 * Wrap a section in a multivariate block gated by a `never` matcher so it never
 * renders on the live site. Parses back as `isHidden`. The original section is
 * preserved verbatim as the variant value, so {@link showSection} can restore
 * it exactly — works for normal, lazy, and saved-block sections alike.
 */
export function hideSection(raw: RawSection): RawSection {
  return {
    __resolveType: SECTION_MULTIVARIATE_RESOLVE_TYPE,
    variants: [
      { value: raw, rule: { __resolveType: NEVER_MATCHER_RESOLVE_TYPE } },
    ],
  } as RawSection;
}

/** Unwrap a hidden section back to the section it was hiding, or null. */
export function showSection(raw: RawSection): RawSection | null {
  const outerLazy = isLazyResolveType(raw.__resolveType);
  const mvObj = (outerLazy ? raw.section : raw) as
    | Record<string, unknown>
    | undefined;
  const variants = mvObj?.variants as
    | Array<Record<string, unknown>>
    | undefined;
  return (variants?.[0]?.value as RawSection | undefined) ?? null;
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
