import {
  getSavedMatcherBlockKey,
  isSavedMatcherBlockReference,
} from "./matcher-rules";
import type { LiveMeta } from "./resolve-schema";

/**
 * Query-param name the deco runtime reads to force matcher activation.
 * See `@deco/deco` `blocks/matcher.ts` (`x-deco-matchers-override`).
 */
export const MATCHER_OVERRIDE_QS = "x-deco-matchers-override";

/**
 * Page-level variant context. A page's `sections` is either a plain array
 * (single variant) or a multivariate wrapper (`{ variants: [{ rule, value }] }`).
 */
export interface PageVariantInfo {
  /** `page.sections` is a multivariate wrapper (page-level variants exist). */
  multivariate: boolean;
  /** Active page variant index (0 when not multivariate). */
  index: number;
  /** Page variant entries — only each entry's `rule` is read. */
  variants: Array<{ rule?: Record<string, unknown> }>;
}

interface OverrideParamsArgs {
  pageKey: string;
  /**
   * Dotted resolve-chain path from the page resolvable up to (and including)
   * the `variants` array that holds the matcher rules — e.g.
   * `sections.variants` for page variants, or
   * `sections.3.section.variants` for a lazy section's variants.
   */
  prefix: string;
  variants: Array<{ rule?: Record<string, unknown> }>;
  selectedIndex: number;
  decofile: Record<string, unknown>;
  meta?: LiveMeta | null;
}

/**
 * Build `"<id>=<1|0>"` override values for one multivariate array.
 *
 * The deco runtime (`blocks/matcher.ts`) computes each matcher's unique id by
 * walking the resolve chain back to the nearest *named resolvable* (a decofile
 * key), skipping resolver/dangling entries, joining `prop` names with `.` and
 * prefixing the resolvable with `@`. So an inline matcher's id is
 * `<pageKey>@<prefix>.<index>.rule`; a *saved matcher block* reference is itself
 * a named resolvable, so its id is just the block key.
 *
 * For the selected index the matcher is forced on (`=1`) and earlier ones off
 * (`=0`); the runtime renders the first matching entry, so later ones are left
 * untouched.
 */
function overrideParamsForVariants({
  pageKey,
  prefix,
  variants,
  selectedIndex,
  decofile,
  meta,
}: OverrideParamsArgs): string[] {
  if (!pageKey || selectedIndex < 0 || selectedIndex >= variants.length) {
    return [];
  }

  const params: string[] = [];
  for (let idx = 0; idx <= selectedIndex; idx++) {
    const variant = variants[idx];
    if (!variant) continue;
    const rule = variant.rule as Record<string, unknown> | undefined;
    const activation = idx === selectedIndex ? "1" : "0";

    const savedBlockKey = isSavedMatcherBlockReference(rule, decofile, meta)
      ? getSavedMatcherBlockKey(rule, decofile, meta)
      : null;

    const id = savedBlockKey ?? `${pageKey}@${prefix}.${idx}.rule`;
    params.push(`${id}=${activation}`);
  }

  return params;
}

/**
 * Force the preview to render the active *page* variant. Returns `[]` when the
 * page is not multivariate (nothing to force).
 */
export function buildPageVariantOverrideParams(
  pageKey: string,
  page: PageVariantInfo,
  decofile: Record<string, unknown>,
  meta?: LiveMeta | null,
): string[] {
  if (!page.multivariate || page.variants.length <= 1) return [];
  return overrideParamsForVariants({
    pageKey,
    prefix: "sections.variants",
    variants: page.variants,
    selectedIndex: page.index,
    decofile,
    meta,
  });
}

export interface SectionVariantOverrideArgs {
  pageKey: string;
  page: PageVariantInfo;
  /** Index of the multivariate section within the active page variant's sections. */
  sectionIndex: number;
  /** The section is wrapped in a Lazy block (adds a `.section` chain segment). */
  sectionLazy: boolean;
  /** The multivariate section object (`{ variants: [{ value, rule }] }`). */
  mvObj: Record<string, unknown>;
  selectedVariantIndex: number;
  decofile: Record<string, unknown>;
  meta?: LiveMeta | null;
}

/**
 * Force the preview to render the selected *section* variant. The resolve-chain
 * prefix accounts for page-level variant nesting (`sections.variants.<pv>.value`)
 * and Lazy wrapping (`.section`).
 */
export function buildSectionVariantOverrideParams({
  pageKey,
  page,
  sectionIndex,
  sectionLazy,
  mvObj,
  selectedVariantIndex,
  decofile,
  meta,
}: SectionVariantOverrideArgs): string[] {
  if (sectionIndex < 0) return [];

  const sectionBase = page.multivariate
    ? `sections.variants.${page.index}.value`
    : "sections";
  const prefix = `${sectionBase}.${sectionIndex}${
    sectionLazy ? ".section" : ""
  }.variants`;

  const variants = Array.isArray(mvObj.variants)
    ? (mvObj.variants as Array<{ rule?: Record<string, unknown> }>)
    : [];

  return overrideParamsForVariants({
    pageKey,
    prefix,
    variants,
    selectedIndex: selectedVariantIndex,
    decofile,
    meta,
  });
}

/**
 * Append override params to a preview URL, returning the new href. Falls
 * back to the unmodified `href` on a malformed input instead of throwing
 * mid-render — `href` comes from the same untrusted sandbox/production
 * preview base as `previewOrigin`/`withDeviceHint` in preview.tsx, which use
 * this same defensive shape (see #6362/#6374).
 */
export function withVariantMatcherOverride(
  href: string,
  params: string[],
): string {
  if (params.length === 0) return href;
  try {
    const url = new URL(href, "http://local");
    url.searchParams.delete(MATCHER_OVERRIDE_QS);
    for (const param of params) {
      url.searchParams.append(MATCHER_OVERRIDE_QS, param);
    }
    // Preserve relative hrefs when the input had no origin.
    return href.startsWith("http")
      ? url.toString()
      : `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return href;
  }
}
