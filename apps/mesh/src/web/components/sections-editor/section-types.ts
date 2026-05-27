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
