/**
 * Resolve a skill catalog id (`<scope>/<rest>`) to the mounted SKILL.md path
 * the `skill` tool reads. Deterministic + traversal-safe: every path segment
 * must be a safe token, so an unknown / `../`-laden id resolves to null rather
 * than escaping a skill scope.
 *
 *   core/slides        → /app/org/public/core/slides/SKILL.md
 *   home/skills/foo    → /app/org/home/skills/foo/SKILL.md
 *   repo/vol/bar       → /app/org/vol/bar/SKILL.md   (synced repo volumes)
 */

import { SANDBOX_ORG_ROOT } from "@decocms/shared/organization/home-mount";

/** One safe path segment — no traversal, hidden dirs, or empties. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function resolveSkillPath(id: string): string | null {
  const parts = id.split("/");
  if (parts.length < 2) return null;
  if (!parts.every((p) => SAFE_SEGMENT.test(p))) return null;
  const [scope, ...rest] = parts;
  const restPath = rest.join("/");
  if (scope === "home") {
    // The org home volume always mounts at the fixed `/app/org/home/`.
    return `${SANDBOX_ORG_ROOT}/home/${restPath}/SKILL.md`;
  }
  if (scope === "repo") {
    // Synced repo volumes mount at `/app/org/<volume>`; the id carries the
    // volume as its second segment, so `repo/<volume>` alone is not a skill.
    if (rest.length < 2) return null;
    return `${SANDBOX_ORG_ROOT}/${restPath}/SKILL.md`;
  }
  // Any other scope is a public set name → /app/org/public/<set>/<rest>.
  return `${SANDBOX_ORG_ROOT}/public/${scope}/${restPath}/SKILL.md`;
}
