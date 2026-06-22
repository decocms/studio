/**
 * Resolve a skill catalog id (`<scope>/<rest>`) to the mounted SKILL.md path
 * the `skill` tool reads. Deterministic + traversal-safe: every path segment
 * must be a safe token, so an unknown / `../`-laden id resolves to null rather
 * than escaping a skill scope.
 *
 *   core/slides        → org/public/core/slides/SKILL.md
 *   home/skills/foo    → org/<home-base>/skills/foo/SKILL.md
 */

/** One safe path segment — no traversal, hidden dirs, or empties. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Names that live directly under `org/` and would shadow a home slug. */
const RESERVED_HOME_PATHS = new Set(["output", "upload", "public", "home"]);

/**
 * The org's home mount base under `org/` — the slug, falling back to literal
 * `home` when the slug collides with a reserved name or isn't a safe segment.
 * Mirrors `homeMountPath` in apps/mesh/src/file-storage/home-mount.ts (kept in
 * sync by hand — the harness package can't import mesh).
 */
function homeMountBase(orgSlug: string): string {
  if (
    !orgSlug ||
    RESERVED_HOME_PATHS.has(orgSlug) ||
    !SAFE_SEGMENT.test(orgSlug)
  ) {
    return "home";
  }
  return orgSlug;
}

export function resolveSkillPath(
  id: string,
  orgSlug: string | null | undefined,
): string | null {
  const parts = id.split("/");
  if (parts.length < 2) return null;
  if (!parts.every((p) => SAFE_SEGMENT.test(p))) return null;
  const [scope, ...rest] = parts;
  const restPath = rest.join("/");
  if (scope === "home") {
    return `org/${homeMountBase(orgSlug ?? "")}/${restPath}/SKILL.md`;
  }
  // Any other scope is a public set name → org/public/<set>/<rest>.
  return `org/public/${scope}/${restPath}/SKILL.md`;
}
