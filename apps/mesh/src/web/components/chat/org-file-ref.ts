/**
 * Maps an agent-emitted org-filesystem path (the `org/…` namespace the sandbox
 * mounts) to a Library browse path (`<volume>/<dir…>`), so a file reference the
 * agent prints in chat can open in the Library preview.
 *
 * Namespace → volume mapping (mirrors file-storage/mount/provisioning.ts):
 *   org/<orgSlug>/<rest…>    → home/<rest…>
 *   org/home/<rest…>         → home/<rest…>        (slug-reserved fallback)
 *   org/public/<set>/<rest…> → public/<set>/<rest…>
 *
 * Thread-scoped mounts (`org/upload/…`, `org/output/…`) are intentionally NOT
 * linked: they resolve through a per-run symlink into a thread subtree, so the
 * volume path can't be derived from the text alone — and those files already
 * surface as their own chips (thread outputs / produced files).
 */

// Trailing `:line` / `:line:col` citation suffix (the `path:line` convention).
const LINE_SUFFIX = /:\d+(?::\d+)?$/;
// A dotted basename, so directory mentions (`org/acme/notes`) aren't linked.
const HAS_EXTENSION = /\.[A-Za-z0-9]+$/;

/**
 * @returns the Library browse path (`home/x.md`, `public/core/y.ts`) or null
 * when `raw` isn't a recognizable, previewable org file path.
 */
export function resolveOrgFileBrowsePath(
  raw: string,
  orgSlug: string | undefined,
): string | null {
  const text = raw.trim().replace(LINE_SUFFIX, "");
  // Single-token path under the org/ mount; a trailing slash marks a directory.
  if (!text || /\s/.test(text) || !text.startsWith("org/")) return null;
  if (text.endsWith("/")) return null;

  const segments = text.split("/").filter(Boolean);
  // org / <vol> / <at least one in-volume segment>.
  if (segments.length < 3) return null;
  const basename = segments.at(-1);
  if (!basename || !HAS_EXTENSION.test(basename)) return null;

  const top = segments[1];

  // org/public/<set>/<rest…> → public/<set>/<rest…>
  if (top === "public") {
    if (segments.length < 4) return null; // need a set and a file under it
    return segments.slice(1).join("/");
  }

  // org/<orgSlug>/<rest…> or org/home/<rest…> → home/<rest…>
  if (top === "home" || (!!orgSlug && top === orgSlug)) {
    return `home/${segments.slice(2).join("/")}`;
  }

  return null;
}
