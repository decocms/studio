/**
 * Maps an agent-emitted org-filesystem path (the `/app/org/…` mount, or the
 * legacy repo-relative `org/…` that older threads carry) to a Library browse
 * path (`<volume>/<dir…>`), so a file reference the agent prints in chat can
 * open in the Library preview.
 *
 * Namespace → volume mapping (mirrors file-storage/mount/provisioning.ts):
 *   <org>/<orgSlug>/<rest…>    → home/<rest…>
 *   <org>/home/<rest…>         → home/<rest…>        (slug-reserved fallback)
 *   <org>/public/<set>/<rest…> → public/<set>/<rest…>
 *   <org>/output/<rest…>       → outputs/<threadId>/<rest…>   (needs threadId)
 *   <org>/upload/<rest…>       → uploads/<threadId>/<rest…>   (needs threadId)
 *
 * The thread-scoped mounts (`output/…`, `upload/…`) resolve through a per-run
 * symlink into a `<threadId>/` subtree, so the text alone can't name the
 * volume path — but the chat knows its own thread, so passing `threadId`
 * makes the deliverable the agent prints ("saved to /app/org/output/report.md")
 * a click-through into the Library. Without a `threadId` they stay unlinked.
 */

import { orgRelativePath } from "@decocms/shared/organization/home-mount";

// Trailing `:line` / `:line:col` citation suffix (the `path:line` convention).
const LINE_SUFFIX = /:\d+(?::\d+)?$/;
// A dotted basename, so directory mentions (`/app/org/acme/notes`) aren't linked.
const HAS_EXTENSION = /\.[A-Za-z0-9]+$/;

/**
 * @returns the Library browse path (`home/x.md`, `public/core/y.ts`) or null
 * when `raw` isn't a recognizable, previewable org file path.
 */
export function resolveOrgFileBrowsePath(
  raw: string,
  orgSlug: string | undefined,
  threadId?: string | undefined,
): string | null {
  const text = raw.trim().replace(LINE_SUFFIX, "");
  // Single-token path under the org mount; a trailing slash marks a directory.
  if (!text || /\s/.test(text) || text.endsWith("/")) return null;
  const relative = orgRelativePath(text);
  if (relative === null) return null;

  const segments = relative.split("/").filter(Boolean);
  // <vol> / <at least one in-volume segment>.
  if (segments.length < 2) return null;
  const basename = segments.at(-1);
  if (!basename || !HAS_EXTENSION.test(basename)) return null;

  const top = segments[0];
  const rest = segments.slice(1).join("/");

  // public/<set>/<rest…>
  if (top === "public") {
    if (segments.length < 3) return null; // need a set and a file under it
    return segments.join("/");
  }

  // <orgSlug>/<rest…> or home/<rest…> → home/<rest…>
  if (top === "home" || (!!orgSlug && top === orgSlug)) {
    return `home/${rest}`;
  }

  // Thread-scoped mounts resolve into the current thread's subtree of the
  // shared volume (output → outputs, upload → uploads). Only linkable
  // with a threadId. ponytail: assumes the file is under THIS thread's folder,
  // which holds unless a shared sandbox misrouted the per-run symlink (rare);
  // a stale link just 404s the preview — no worse than the unlinked text.
  if (threadId) {
    if (top === "output") return `outputs/${threadId}/${rest}`;
    if (top === "upload") return `uploads/${threadId}/${rest}`;
  }

  return null;
}
