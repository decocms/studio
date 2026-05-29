/**
 * Heuristic predicate: does this decofile look like a Deco site?
 *
 * Used to decide whether to surface Deco-specific UI (Content tab,
 * sections editor) for a sandbox. Treats any entry whose `__resolveType`
 * lives under a Deco namespace (`website/`, `$live/`, `deco-sites/`,
 * `decocx/`) as proof — covers both standard templates and forked
 * starter projects. False for empty objects, non-Deco frameworks, and
 * fetch failures (which surface as `undefined`).
 */
const DECO_RESOLVE_PREFIXES = ["website/", "$live/", "deco-sites/", "decocx/"];

export function isDecoSiteDecofile(
  decofile: Record<string, unknown> | undefined | null,
): boolean {
  if (!decofile) return false;
  for (const val of Object.values(decofile)) {
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const rt = (val as { __resolveType?: unknown }).__resolveType;
    if (typeof rt !== "string") continue;
    if (DECO_RESOLVE_PREFIXES.some((p) => rt.startsWith(p))) return true;
  }
  return false;
}
