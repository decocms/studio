import type { LiveMeta } from "./resolve-schema";
import {
  isSavedMatcherBlockReference,
  resolveVariantRuleLabel,
} from "./matcher-rules";
import type { RawSection } from "./section-types";

const PAGE_RESOLVE_TYPES = new Set([
  "website/pages/Page.tsx",
  "$live/pages/LivePage.tsx",
]);

export interface PageVariant {
  label: string;
  sections: RawSection[];
  rule?: Record<string, unknown>;
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
    return {
      variants: [{ value: current }, { value: seed }],
    };
  }
  if (current && typeof current === "object") {
    const obj = current as Record<string, unknown>;
    if (Array.isArray(obj.variants)) {
      return {
        ...obj,
        variants: [...(obj.variants as unknown[]), { value: seed }],
      };
    }
    return null;
  }
  return { variants: [{ value: [] }, { value: seed }] };
}

export function getLastVariantIndex(
  updatedSections: Record<string, unknown>,
): number {
  const variants = updatedSections.variants;
  return Array.isArray(variants) ? variants.length - 1 : 1;
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
    return { ...obj, variants: [] };
  }
  if (variants.length === 1) {
    const only = variants[0];
    if (variantHasRule(only)) {
      return { ...obj, variants };
    }
    if (Array.isArray(only?.value)) {
      return only.value as unknown[];
    }
  }
  return { ...obj, variants };
}

export function forEachPageVariantRule(
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
