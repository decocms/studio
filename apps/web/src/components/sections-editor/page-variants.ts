import type { LiveMeta, SchemaProperty } from "./resolve-schema";
import { resolveVariantRuleLabel } from "./matcher-rules";
import { findSavedMatcherReferences } from "./rule-references";
import {
  duplicateVariantIndex,
  isDefaultVariantRule,
  newVariantIndex,
} from "./section-variants";
import type { RawSection } from "./section-types";
import {
  defaultVariantRule,
  PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
  SECTION_MULTIVARIATE_RESOLVE_TYPE,
} from "./section-types";
import {
  readVariantValue,
  storeVariantValue,
  V8_MULTIVARIATE_RESOLVE_TYPE,
  valueMultivariateResolveType,
  withVariantValue,
} from "./variant-shape";

export interface PageVariant {
  label: string;
  sections: RawSection[];
  rule?: Record<string, unknown>;
}

/**
 * The section-list schema of a page-variants field: the list each variant's
 * `value` holds, under v7's page flag or v8's `multivariate` (where the value
 * is a `lazy` block around the list). `undefined` for any other field.
 */
export function pageMultivariateSectionListSchema(
  schema: SchemaProperty,
): SchemaProperty | undefined {
  for (const ref of schema.anyOfRefs ?? []) {
    if (
      ref.resolveType !== PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE &&
      ref.resolveType !== V8_MULTIVARIATE_RESOLVE_TYPE
    ) {
      continue;
    }
    const valueField =
      ref.schema?.properties?.variants?.items?.properties?.value;
    // Under `multivariate` the value is a `lazy` block around the list.
    const listField = valueField?.lazy
      ? valueField.properties?.value
      : valueField;
    if (listField?.type === "array") return listField;
  }
  return undefined;
}

export function isPageMultivariateSectionArrayField(
  schema: SchemaProperty,
): boolean {
  return pageMultivariateSectionListSchema(schema) !== undefined;
}

/**
 * True when a value is a section-level multivariate flag wrapper —
 * `{ __resolveType: "website/flags/multivariate/section.ts", variants: [...] }`,
 * or v8's `multivariate` around single values (not a page's section lists).
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
  if (!Array.isArray(obj.variants)) return false;
  if (obj.__resolveType === SECTION_MULTIVARIATE_RESOLVE_TYPE) return true;
  return (
    obj.__resolveType === V8_MULTIVARIATE_RESOLVE_TYPE &&
    !holdsSectionLists(obj.variants)
  );
}

/** Whether a variants list holds lists (a page's sections), not single values. */
function holdsSectionLists(variants: unknown[]): boolean {
  return variants.some((variant) => Array.isArray(readVariantValue(variant)));
}

/**
 * Site `global` and page `sections` can be a plain array or page multivariate
 * wrapper: v7's `website/flags/multivariate.ts`, or v8's `multivariate` whose
 * variants hold section lists.
 */
export function isMultivariateArrayWrapper(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (obj.__resolveType === PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE) return true;
  return (
    obj.__resolveType === V8_MULTIVARIATE_RESOLVE_TYPE &&
    Array.isArray(obj.variants) &&
    holdsSectionLists(obj.variants)
  );
}

export function unwrapMultivariateArrayValue(value: unknown): unknown[] | null {
  if (!isMultivariateArrayWrapper(value)) return null;
  const variants = (value as Record<string, unknown>).variants as
    | Array<{ value?: unknown }>
    | undefined;
  if (!Array.isArray(variants)) return null;
  const first = readVariantValue(variants[0]);
  return Array.isArray(first) ? first : null;
}

export function wrapMultivariateArrayValue(
  original: unknown,
  nextArray: unknown[],
  meta?: LiveMeta | null,
): unknown {
  if (!isMultivariateArrayWrapper(original)) return nextArray;
  const obj = structuredClone(original) as Record<string, unknown>;
  const variants = [
    ...((obj.variants as Array<Record<string, unknown>>) ?? []),
  ];
  if (variants.length === 0) {
    variants.push({
      rule: defaultVariantRule(meta),
      value: storeVariantValue(obj.__resolveType, nextArray),
    });
  } else {
    variants[0] = withVariantValue(obj.__resolveType, variants[0]!, nextArray);
  }
  return { ...obj, variants };
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
      const value = readVariantValue(variants[variantIndex]);
      return Array.isArray(value) ? (value as RawSection[]) : [];
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
        const value = readVariantValue(v);
        return {
          label: label || `Variant ${i + 1}`,
          sections: Array.isArray(value) ? (value as RawSection[]) : [],
          rule: v.rule,
        };
      });
    }
  }
  return [];
}

function createPageVariantEntry(
  value: RawSection[],
  meta: LiveMeta | null | undefined,
  resolveType: string,
): Record<string, unknown> {
  return {
    rule: defaultVariantRule(meta),
    value: storeVariantValue(resolveType, value),
  };
}

/**
 * The type a page's variants block is saved with: a new one takes the
 * site's (`multivariate` on v8), an existing `multivariate` keeps its name,
 * and any other is saved as the v7 page flag, as before.
 */
function pageMultivariateTypeFor(
  existing: Record<string, unknown> | undefined,
  meta?: LiveMeta | null,
): string {
  if (!existing) return valueMultivariateResolveType(meta);
  return existing.__resolveType === V8_MULTIVARIATE_RESOLVE_TYPE
    ? V8_MULTIVARIATE_RESOLVE_TYPE
    : PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE;
}

function createMultivariatePageSections(
  variants: Array<Record<string, unknown>>,
  existing?: Record<string, unknown>,
  meta?: LiveMeta | null,
): Record<string, unknown> {
  return {
    ...existing,
    __resolveType: pageMultivariateTypeFor(existing, meta),
    variants,
  };
}

/**
 * Add a page variant seeded from `seedSections`. On a Blocks v8 site it goes
 * above the trailing catch-all (see `newVariantIndex`), and a page without
 * variants becomes the new variant followed by the current sections. Any
 * other site keeps v7's order: the new variant last, after the current
 * sections. Returns null when the current sections shape cannot be extended.
 */
export function appendPageVariantSections(
  current: unknown,
  seedSections: RawSection[],
  meta?: LiveMeta | null,
  /** A Blocks v8 site. */
  v8 = false,
): { sections: Record<string, unknown>; newVariantIndex: number } | null {
  const seed = structuredClone(seedSections);
  if (current && typeof current === "object" && !Array.isArray(current)) {
    const obj = current as Record<string, unknown>;
    if (!Array.isArray(obj.variants)) return null;
    const variants = [...(obj.variants as Array<Record<string, unknown>>)];
    const insertAt = newVariantIndex(variants, v8);
    variants.splice(
      insertAt,
      0,
      createPageVariantEntry(seed, meta, pageMultivariateTypeFor(obj)),
    );
    return {
      sections: createMultivariatePageSections(variants, obj),
      newVariantIndex: insertAt,
    };
  }
  const newType = pageMultivariateTypeFor(undefined, meta);
  if (!v8) {
    // v7: the current sections (none for an unknown shape), then the new one.
    return {
      sections: createMultivariatePageSections(
        [
          createPageVariantEntry(
            Array.isArray(current) ? (current as RawSection[]) : [],
            meta,
            newType,
          ),
          createPageVariantEntry(seed, meta, newType),
        ],
        undefined,
        meta,
      ),
      newVariantIndex: 1,
    };
  }
  return {
    sections: createMultivariatePageSections(
      [
        createPageVariantEntry(seed, meta, newType),
        createPageVariantEntry(
          Array.isArray(current) ? (current as RawSection[]) : [],
          meta,
          newType,
        ),
      ],
      undefined,
      meta,
    ),
    newVariantIndex: 0,
  };
}

/**
 * Insert a clone of the variant at `variantIndex` (rule and sections included)
 * at `duplicateVariantIndex`. Returns the next variants array, or null when
 * the source variant is missing.
 */
export function duplicatePageVariantEntry(
  variants: Array<Record<string, unknown>>,
  variantIndex: number,
  /** A Blocks v8 site (see `duplicateVariantIndex`). */
  v8 = false,
): Array<Record<string, unknown>> | null {
  const source = variants[variantIndex];
  if (!source) return null;
  const next = [...variants];
  next.splice(
    duplicateVariantIndex(variants, variantIndex, v8),
    0,
    structuredClone(source),
  );
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
    const value = readVariantValue(only);
    if (Array.isArray(value)) {
      return value as unknown[];
    }
  }
  return createMultivariatePageSections(variants, obj);
}

/**
 * How many places still reference the saved matcher block `blockKey`. The
 * caller deletes the block when this is 0, so a missed reference deletes live
 * user data: the search (`findSavedMatcherReferences`) inspects every object
 * in the decofile, not just page variant rules. Over-counting merely keeps an
 * unused block around; under-counting destroys data.
 */
export function countSavedMatcherBlockReferences(
  decofile: Record<string, unknown>,
  blockKey: string,
  meta?: LiveMeta | null,
): number {
  return findSavedMatcherReferences(decofile, blockKey, meta).length;
}
