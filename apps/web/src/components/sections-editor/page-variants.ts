import type { LiveMeta, SchemaProperty } from "./resolve-schema";
import {
  isSavedMatcherBlockReference,
  resolveVariantRuleLabel,
} from "./matcher-rules";
import { isDefaultVariantRule } from "./section-variants";
import type { RawSection } from "./section-types";
import {
  defaultVariantRule,
  PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
  SECTION_MULTIVARIATE_RESOLVE_TYPE,
} from "./section-types";

const PAGE_RESOLVE_TYPES = new Set([
  "website/pages/Page.tsx",
  "$live/pages/LivePage.tsx",
]);

export interface PageVariant {
  label: string;
  sections: RawSection[];
  rule?: Record<string, unknown>;
}

export function isPageMultivariateSectionArrayField(
  schema: SchemaProperty,
): boolean {
  return (
    schema.anyOfRefs?.some((ref) => {
      if (ref.resolveType !== PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE) return false;
      const valueField =
        ref.schema?.properties?.variants?.items?.properties?.value;
      return valueField?.type === "array";
    }) ?? false
  );
}

/**
 * True when a value is a section-level multivariate flag wrapper —
 * `{ __resolveType: "website/flags/multivariate/section.ts", variants: [...] }`.
 *
 * This is the shape a saved/global block takes when it wraps a single section
 * in variants (each `{ value: Section, rule: Matcher }`). It must render with
 * the variant editor, not the generic array editor.
 */
export function isSectionMultivariateWrapperValue(value: unknown): value is {
  __resolveType: string;
  variants: Array<Record<string, unknown>>;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.__resolveType === SECTION_MULTIVARIATE_RESOLVE_TYPE &&
    Array.isArray(obj.variants)
  );
}

/** Site `global` and page `sections` can be a plain array or page multivariate wrapper. */
export function isMultivariateArrayWrapper(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (
    (value as Record<string, unknown>).__resolveType ===
    PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE
  );
}

export function unwrapMultivariateArrayValue(value: unknown): unknown[] | null {
  if (!isMultivariateArrayWrapper(value)) return null;
  const variants = (value as Record<string, unknown>).variants as
    | Array<{ value?: unknown }>
    | undefined;
  if (!Array.isArray(variants)) return null;
  const first = variants[0]?.value;
  return Array.isArray(first) ? first : null;
}

export function wrapMultivariateArrayValue(
  original: unknown,
  nextArray: unknown[],
): unknown {
  if (!isMultivariateArrayWrapper(original)) return nextArray;
  const obj = structuredClone(original) as Record<string, unknown>;
  const variants = [
    ...((obj.variants as Array<Record<string, unknown>>) ?? []),
  ];
  if (variants.length === 0) {
    variants.push({ rule: defaultVariantRule(), value: nextArray });
  } else {
    variants[0] = { ...variants[0], value: nextArray };
  }
  return { ...obj, variants };
}

function isPageBlock(val: unknown): val is Record<string, unknown> {
  if (!val || typeof val !== "object" || Array.isArray(val)) return false;
  const obj = val as Record<string, unknown>;
  return (
    typeof obj.__resolveType === "string" &&
    PAGE_RESOLVE_TYPES.has(obj.__resolveType) &&
    typeof obj.path === "string"
  );
}

export function getPageVariantCount(
  decofile: Record<string, unknown>,
  pageKey: string,
): number {
  const pageData = decofile[pageKey] as Record<string, unknown> | undefined;
  const sections = pageData?.sections;
  if (!sections || Array.isArray(sections)) return 1;
  const obj = sections as Record<string, unknown>;
  if (Array.isArray(obj.variants)) return (obj.variants as unknown[]).length;
  return 1;
}

export function getPageVariantSectionsAt(
  decofile: Record<string, unknown>,
  pageKey: string,
  variantIndex: number,
): RawSection[] {
  const pageData = decofile[pageKey] as Record<string, unknown> | undefined;
  const sections = pageData?.sections;
  if (Array.isArray(sections)) {
    return variantIndex === 0 ? sections : [];
  }
  if (sections && typeof sections === "object") {
    const variants = (sections as Record<string, unknown>).variants;
    if (Array.isArray(variants)) {
      const entry = variants[variantIndex] as
        | Record<string, unknown>
        | undefined;
      return Array.isArray(entry?.value) ? (entry.value as RawSection[]) : [];
    }
  }
  return [];
}

export function parsePageVariants(
  sections: unknown,
  decofile: Record<string, unknown>,
  formatMatcher: (rule?: Record<string, unknown>) => string,
): PageVariant[] {
  if (Array.isArray(sections)) {
    return [{ label: "Default", sections }];
  }
  if (sections && typeof sections === "object") {
    const obj = sections as Record<string, unknown>;
    if (Array.isArray(obj.variants)) {
      const raw = obj.variants as Array<{
        rule?: Record<string, unknown>;
        value?: unknown;
      }>;
      const labels = raw.map((v) =>
        resolveVariantRuleLabel(v.rule, decofile, formatMatcher),
      );
      const labelCounts = labels.reduce<Record<string, number>>((acc, l) => {
        acc[l] = (acc[l] ?? 0) + 1;
        return acc;
      }, {});
      const seen: Record<string, number> = {};
      return raw.map((v, i) => {
        const baseLabel = labels[i] ?? `Variant ${i + 1}`;
        const total = labelCounts[baseLabel] ?? 1;
        let label = baseLabel;
        if (total > 1) {
          seen[baseLabel] = (seen[baseLabel] ?? 0) + 1;
          label = `${baseLabel} ${seen[baseLabel]}`;
        }
        return {
          label: label || `Variant ${i + 1}`,
          sections: Array.isArray(v.value) ? (v.value as RawSection[]) : [],
          rule: v.rule,
        };
      });
    }
  }
  return [];
}

function createPageVariantEntry(value: RawSection[]): Record<string, unknown> {
  return {
    rule: defaultVariantRule(),
    value,
  };
}

function createMultivariatePageSections(
  variants: Array<Record<string, unknown>>,
  existing?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...existing,
    __resolveType: PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
    variants,
  };
}

/**
 * Append a new page variant seeded from `seedSections`. Returns null when the
 * current sections shape cannot be extended.
 */
export function appendPageVariantSections(
  current: unknown,
  seedSections: RawSection[],
): Record<string, unknown> | null {
  const seed = structuredClone(seedSections);
  if (Array.isArray(current)) {
    return createMultivariatePageSections([
      createPageVariantEntry(current),
      createPageVariantEntry(seed),
    ]);
  }
  if (current && typeof current === "object") {
    const obj = current as Record<string, unknown>;
    if (Array.isArray(obj.variants)) {
      return createMultivariatePageSections(
        [
          ...(obj.variants as Array<Record<string, unknown>>),
          createPageVariantEntry(seed),
        ],
        obj,
      );
    }
    return null;
  }
  return createMultivariatePageSections([
    createPageVariantEntry([]),
    createPageVariantEntry(seed),
  ]);
}

export function getLastVariantIndex(
  updatedSections: Record<string, unknown>,
): number {
  const variants = updatedSections.variants;
  return Array.isArray(variants) ? variants.length - 1 : 1;
}

/**
 * Insert a clone of the variant at `variantIndex` immediately after it (rule and
 * sections included). Returns the next variants array, or null when the source
 * variant is missing.
 */
export function duplicatePageVariantEntry(
  variants: Array<Record<string, unknown>>,
  variantIndex: number,
): Array<Record<string, unknown>> | null {
  const source = variants[variantIndex];
  if (!source) return null;
  const next = [...variants];
  next.splice(variantIndex + 1, 0, structuredClone(source));
  return next;
}

/** Returns true when the variant entry carries a targeting rule. */
export function variantHasRule(
  variant: Record<string, unknown> | undefined,
): boolean {
  if (!variant?.rule || typeof variant.rule !== "object") return false;
  return Object.keys(variant.rule as Record<string, unknown>).length > 0;
}

/**
 * Persist page sections after a variant mutation. Keeps multivariate shape when
 * the sole remaining variant still has a rule so targeting is not dropped.
 */
export function buildPageSectionsFromVariants(
  obj: Record<string, unknown>,
  variants: Array<Record<string, unknown>>,
): unknown {
  if (variants.length === 0) {
    return createMultivariatePageSections([], obj);
  }
  if (variants.length === 1) {
    const only = variants[0];
    const rule = only?.rule as Record<string, unknown> | undefined;
    if (!isDefaultVariantRule(rule)) {
      return createMultivariatePageSections(variants, obj);
    }
    if (Array.isArray(only?.value)) {
      return only.value as unknown[];
    }
  }
  return createMultivariatePageSections(variants, obj);
}

function forEachPageVariantRule(
  decofile: Record<string, unknown>,
  visit: (
    rule: Record<string, unknown> | undefined,
    pageKey: string,
    variantIndex: number,
  ) => void,
): void {
  for (const [pageKey, val] of Object.entries(decofile)) {
    if (!isPageBlock(val)) continue;
    const sections = val.sections;
    if (Array.isArray(sections)) {
      visit(undefined, pageKey, 0);
      continue;
    }
    if (!sections || typeof sections !== "object") continue;
    const variants = (sections as Record<string, unknown>).variants;
    if (!Array.isArray(variants)) continue;
    for (let i = 0; i < variants.length; i++) {
      const variant = variants[i] as Record<string, unknown> | undefined;
      visit(variant?.rule as Record<string, unknown> | undefined, pageKey, i);
    }
  }
}

export function countSavedMatcherBlockReferences(
  decofile: Record<string, unknown>,
  blockKey: string,
  meta?: LiveMeta | null,
): number {
  let count = 0;
  forEachPageVariantRule(decofile, (rule) => {
    if (!rule) return;
    const rt = (rule.__resolveType as string) ?? "";
    if (rt === blockKey && isSavedMatcherBlockReference(rule, decofile, meta)) {
      count++;
    }
  });
  return count;
}
