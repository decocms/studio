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

export const ALWAYS_MATCHER_RESOLVE_TYPE = "website/matchers/always.ts";

/** Matcher that never matches — used to hide a section from the live site. */
export const NEVER_MATCHER_RESOLVE_TYPE = "website/matchers/never.ts";

export const PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE =
  "website/flags/multivariate.ts";

/** Multivariate wrapper for a single section (used for variants and hiding). */
export const SECTION_MULTIVARIATE_RESOLVE_TYPE =
  "website/flags/multivariate/section.ts";

/** Human label from a deco resolve type path or block id. */
export function labelFromResolveType(rt: string): string {
  const segments = rt.split("/");
  const filename = segments[segments.length - 1] ?? rt;
  return (
    filename
      .replace(/\.(tsx?|jsx?)$/, "")
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()) || rt
  );
}

export function sectionsDisplayKey(
  sections: Array<{
    resolveType: string;
    label: string;
    isHidden?: boolean;
    isSavedBlock?: boolean;
    isMultivariate?: boolean;
    isLazy?: boolean;
  }>,
): string {
  return sections
    .map(
      (section) =>
        `${section.resolveType}|${section.label}|${section.isHidden ?? false}|${section.isSavedBlock ?? false}|${section.isMultivariate ?? false}|${section.isLazy ?? false}`,
    )
    .join("\n");
}
