/**
 * The org `home` volume's identity, split into two concerns:
 *
 *   - HOME_MOUNT_PATH — the fixed path the agent/sandbox sees it mounted at
 *     (`/app/org/home/`). Stable across every org so prompts, skills, and
 *     code can hardcode the path instead of templating the slug.
 *   - homeDisplayName — the human label the Library shows for the same folder
 *     (the org's slug), so members recognize it as their own.
 *
 * Dependency-free so both browser and server consumers can import it.
 */

/** Where org-fs is mounted in every sandbox. Agent-facing org paths are
 *  absolute under it: a link to org-fs inside the repo gets crawled by dev
 *  server file watchers, which stalls boot for minutes on a large org. */
export const SANDBOX_ORG_ROOT = "/app/org";

/** The cwd-relative form agents were taught before org paths went absolute;
 *  older threads and user-written skills still carry it. */
const LEGACY_ORG_PREFIX = "org/";

/** An agent-written org path (`/app/org/output/x.png`, or the legacy
 *  `org/output/x.png`) relative to the org root (`output/x.png`); null when
 *  the path isn't under org-fs. */
export function orgRelativePath(path: string): string | null {
  const p = path.startsWith("./") ? path.slice(2) : path;
  for (const prefix of [`${SANDBOX_ORG_ROOT}/`, LEGACY_ORG_PREFIX]) {
    if (p.startsWith(prefix)) return p.slice(prefix.length);
  }
  return null;
}

/** The agent-facing mount path for the org's `home` volume — always `home`,
 *  so `/app/org/home/` is a stable, hardcodable path in prompts/skills/code. */
export const HOME_MOUNT_PATH = "home";

/** Other names that live directly under the org root — a slug matching one of
 *  these would shadow it in the Library's folder list. */
const RESERVED_HOME_PATHS = new Set(["output", "upload", "public", "home"]);
/** One safe path segment, no traversal/hidden dirs (mirrors thread-links). */
const SAFE_MOUNT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Display label for the home folder in the Library — the org's own slug,
 *  falling back to a literal `home` when the slug would collide with another
 *  org-root entry or isn't a safe segment. Display-only: the path the agent
 *  reads/writes is always `HOME_MOUNT_PATH`. */
export function homeDisplayName(orgSlug: string): string {
  if (RESERVED_HOME_PATHS.has(orgSlug) || !SAFE_MOUNT_SEGMENT.test(orgSlug)) {
    return "home";
  }
  return orgSlug;
}
