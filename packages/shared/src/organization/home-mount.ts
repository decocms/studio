/**
 * The org `home` volume's identity, split into two concerns:
 *
 *   - HOME_MOUNT_PATH — the fixed path the agent/sandbox sees it mounted at
 *     (`org/home/`). Stable across every org so prompts, skills, and code can
 *     hardcode the path instead of templating the slug.
 *   - homeDisplayName — the human label the Library shows for the same folder
 *     (the org's slug), so members recognize it as their own.
 *
 * Dependency-free so both browser and server consumers can import it.
 */

/** The agent-facing mount path for the org's `home` volume — always `home`,
 *  so `org/home/` is a stable, hardcodable path in prompts/skills/code. */
export const HOME_MOUNT_PATH = "home";

/** Other names that live directly under `org/` — a slug matching one of
 *  these would shadow it in the Library's folder list. */
const RESERVED_HOME_PATHS = new Set(["output", "upload", "public", "home"]);
/** One safe path segment, no traversal/hidden dirs (mirrors thread-links). */
const SAFE_MOUNT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Display label for the home folder in the Library — the org's own slug,
 *  falling back to a literal `home` when the slug would collide with another
 *  `org/` entry or isn't a safe segment. Display-only: the path the agent
 *  reads/writes is always `HOME_MOUNT_PATH`. */
export function homeDisplayName(orgSlug: string): string {
  if (RESERVED_HOME_PATHS.has(orgSlug) || !SAFE_MOUNT_SEGMENT.test(orgSlug)) {
    return "home";
  }
  return orgSlug;
}
