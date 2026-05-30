import { isLazyResolveType } from "./section-lazy";
import type { RawSection } from "./section-types";

export type { RawSection };

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
