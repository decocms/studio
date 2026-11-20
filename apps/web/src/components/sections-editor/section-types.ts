import { isV8Schema } from "@decocms/shared/blocks-major";
import type { LiveMeta } from "./resolve-schema";

export interface RawSection {
  __resolveType: string;
  section?: { __resolveType?: string; [key: string]: unknown };
  variants?: Array<{
    value?: Record<string, unknown>;
    rule?: Record<string, unknown>;
  }>;
  [key: string]: unknown;
}

export const GLOBAL_SECTION_ICON_COLOR = "oklch(0.7278 0.151 289)";

const ALWAYS_MATCHER_RESOLVE_TYPE = "website/matchers/always.ts";

/** Matcher that never matches — used to hide a section from the live site. */
const NEVER_MATCHER_RESOLVE_TYPE = "website/matchers/never.ts";

export const PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE =
  "website/flags/multivariate.ts";

/** Multivariate wrapper for a single section (used for variants and hiding). */
export const SECTION_MULTIVARIATE_RESOLVE_TYPE =
  "website/flags/multivariate/section.ts";

/** The names the "always" matcher goes by on v7 and Fresh/Deno. */
const ALWAYS_MATCHER_NAMES = new Set([
  ALWAYS_MATCHER_RESOLVE_TYPE,
  "$live/matchers/MatchAlways.ts",
]);

/**
 * Whether a rule type is the "always" matcher. A Blocks v8 site (`v8`) also
 * names it `always`; on v7 that short name is a saved block, as before.
 */
export function isAlwaysMatcherResolveType(
  resolveType: unknown,
  v8 = false,
): boolean {
  return (
    typeof resolveType === "string" &&
    (ALWAYS_MATCHER_NAMES.has(resolveType) || (v8 && resolveType === "always"))
  );
}

/**
 * Whether a rule type is the "never" matcher. A Blocks v8 site (`v8`) also
 * names it `never`; on v7 that short name is a saved block, as before.
 */
export function isNeverMatcherResolveType(
  resolveType: unknown,
  v8 = false,
): boolean {
  return (
    typeof resolveType === "string" &&
    (resolveType === NEVER_MATCHER_RESOLVE_TYPE ||
      (v8 && resolveType === "never"))
  );
}

/**
 * Whether a Blocks v8 site's schema (`isV8Schema`) lists a matcher under this
 * name. Any other site writes the v7 names.
 */
function declaresMatcher(meta: SiteMeta, name: string): boolean {
  if (!isV8Schema(meta)) return false;
  return Object.hasOwn(meta?.manifest?.blocks?.matchers ?? {}, name);
}

/** The schema, or nothing yet: the v7 names are written until it loads. */
type SiteMeta = Pick<LiveMeta, "manifest"> | null | undefined;

/**
 * The "always" matcher type the site declares: `always` on next-major sites,
 * the v7 file name otherwise.
 */
export function alwaysMatcherResolveType(meta: SiteMeta): string {
  return declaresMatcher(meta, "always")
    ? "always"
    : ALWAYS_MATCHER_RESOLVE_TYPE;
}

/**
 * The "never" matcher type the site declares: `never` on next-major sites,
 * the v7 file name otherwise.
 */
export function neverMatcherResolveType(meta: SiteMeta): string {
  return declaresMatcher(meta, "never") ? "never" : NEVER_MATCHER_RESOLVE_TYPE;
}

/** Default variant rule — always matches, used as the seed for new variants. */
export function defaultVariantRule(meta?: SiteMeta): Record<string, unknown> {
  return { __resolveType: alwaysMatcherResolveType(meta) };
}

/**
 * Human label from a resolve type path or block id. Template-based sections
 * (e.g. `vendor/sections/banner_carousel.html`) drop their extension too.
 */
export function labelFromResolveType(rt: string): string {
  const segments = rt.split("/");
  const filename = segments[segments.length - 1] ?? rt;
  return (
    capitalizeWords(
      filename.replace(/\.(tsx?|jsx?|html?)$/, "").replace(/[-_]/g, " "),
    ) || rt
  );
}

/**
 * Capitalize each word. Unicode-aware: `\b\w` is ASCII-only, so an accented
 * letter read as a word boundary and "benefícios" became "BenefíCios".
 */
export function capitalizeWords(s: string): string {
  return s.replace(/(?<![\p{L}\p{M}\p{N}])\p{L}/gu, (c) => c.toUpperCase());
}
