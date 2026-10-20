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

/**
 * Visit every object reachable from the decofile, skipping the subtree stored
 * under `skipKey`. The walk is iterative so a deep block cannot overflow the
 * stack, and it memoizes object identity so malformed or cyclic user data
 * terminates. A consequence of the memo: an object reachable from two
 * positions is visited once.
 */
function forEachDecofileObject(
  decofile: Record<string, unknown>,
  skipKey: string | null,
  visit: (node: Record<string, unknown>) => void,
): void {
  const stack: unknown[] = [];
  for (const [key, value] of Object.entries(decofile)) {
    if (key === skipKey) continue;
    stack.push(value);
  }
  const seen = new Set<object>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    visit(node as Record<string, unknown>);
    for (const value of Object.values(node)) stack.push(value);
  }
}

/**
 * How many places still reference the saved matcher block `blockKey`. The
 * caller deletes the block when this is 0, so a missed reference deletes live
 * user data — hence the walk is shape-blind: every object in the decofile is
 * inspected, not just page variant rules. A reference reaches a matcher from a
 * page variant's `rule`, from inside a `website/matchers/multi.ts` `matchers`
 * array at any depth, from a section- or field-level
 * `<scope>/flags/multivariate/<kind>.ts` container nested anywhere, or from any
 * non-page block (a saved global section wrapper, another saved matcher).
 *
 * Over-counting merely keeps an unused block around; under-counting destroys
 * data, so unknown shapes count as references. The block's own body is skipped:
 * a self-reference in malformed data would otherwise pin the orphan forever.
 */
export function countSavedMatcherBlockReferences(
  decofile: Record<string, unknown>,
  blockKey: string,
  meta?: LiveMeta | null,
): number {
  if (!blockKey) return 0;
  let count = 0;
  forEachDecofileObject(decofile, blockKey, (node) => {
    if (node.__resolveType !== blockKey) return;
    if (isSavedMatcherBlockReference(node, decofile, meta)) count++;
  });
  return count;
}
