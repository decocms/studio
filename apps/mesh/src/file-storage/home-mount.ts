/**
 * Mount path for the org's `home` volume — shared by sandbox provisioning
 * (the actual mount) and the Library UI (the card label), so the name the
 * user sees always matches the path the agent sees. Dependency-free on
 * purpose: the web bundle imports this directly.
 */

/** Other names that live directly under `org/` — a slug matching one of
 *  these would shadow it. */
const RESERVED_HOME_PATHS = new Set(["output", "upload", "public", "home"]);
/** One safe path segment, no traversal/hidden dirs (mirrors thread-links). */
const SAFE_MOUNT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The org's own slug (immutable), so the agent sees `org/<slug>/`. Falls
 *  back to a literal `home` when the slug would collide with another `org/`
 *  entry or isn't a safe segment. */
export function homeMountPath(orgSlug: string): string {
  if (RESERVED_HOME_PATHS.has(orgSlug) || !SAFE_MOUNT_SEGMENT.test(orgSlug)) {
    return "home";
  }
  return orgSlug;
}
