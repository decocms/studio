import { orgFsSandboxPath } from "@/file-storage/mount/provisioning";

/**
 * Point a task description's uploaded files at the sandbox, not at Studio.
 *
 * The markdown editor stores an upload as a link to the org filesystem's HTTP
 * read endpoint (`/api/:org/fs/:volume/read?path=…`, see
 * `apps/web/src/components/markdown-editor/uploads.ts`). That URL is relative
 * and cookie-authenticated, so it means nothing inside a sandbox: an agent
 * handed the raw description sees `![image.png](/api/…)` and has no way to
 * fetch it. It reads as text and gets treated as one — an earlier run
 * described an image it had never seen.
 *
 * The same bytes are already mounted in the pod (`/app/org/.uploads/…`), so
 * the fix is to rewrite the URL to that path. `Read` renders a PNG visually,
 * so the model actually looks at the screenshot the task is about.
 *
 * Sandboxed runs ONLY — a hosted harness has no org-fs mount, and there the
 * original URL is at least a link a human can click.
 */
export function uploadsAsSandboxPaths(description: string): string {
  return readUrlsAsSandboxPaths(description, READ_URL, () => true);
}

/**
 * An org-fs read URL, capturing its org, volume and path still encoded. The
 * editor writes `?path=` as the whole query, so everything up to the closing
 * paren (or whitespace) is the path.
 */
const READ_URL = /\/api\/([^/\s)]+)\/fs\/([^/\s)]+)\/read\?path=([^)\s]+)/g;
/** The same URL as a markdown link or image target, all `sandboxPathsAsUploads` restores. */
const LINKED_READ_URL = new RegExp(
  String.raw`(?<=\]\()${READ_URL.source}(?=\))`,
  "g",
);

function readUrlsAsSandboxPaths(
  markdown: string,
  pattern: RegExp,
  include: (org: string, volume: string, path: string) => boolean,
): string {
  return markdown.replace(
    pattern,
    (url, encodedOrg: string, encodedVolume: string, encodedPath: string) => {
      let org: string;
      let volume: string;
      let path: string;
      try {
        org = decodeURIComponent(encodedOrg);
        volume = decodeURIComponent(encodedVolume);
        path = decodeURIComponent(encodedPath);
      } catch {
        return url;
      }
      if (!include(org, volume, path)) return url;
      // Checked on the DECODED value: `%2F` hides a climb-out slash from the capture.
      if (climbsOut(volume) || climbsOut(path)) return url;
      return orgFsSandboxPath(volume, path);
    },
  );
}

function climbsOut(part: string): boolean {
  return part.startsWith("/") || part.split("/").includes("..");
}

/**
 * The mounts a comment's links move into for a run, and back out of when it
 * writes one. Hidden, so no person types their paths; and each names its
 * volume, where `org/<volume>` could be the run's own `org/output` or `org/upload`.
 */
const COMMENT_MOUNTS = ["uploads", "outputs"].map((volume) => ({
  volume,
  prefix: `${orgFsSandboxPath(volume, "")}/`,
}));

/** A comment as a run lists it: only this org's links that `sandboxPathsAsUploads` restores, since a run may post it back. */
export function commentUploadsAsSandboxPaths(
  body: string,
  orgSlug: string,
): string {
  return readUrlsAsSandboxPaths(
    body,
    LINKED_READ_URL,
    (org, volume, path) =>
      org === orgSlug &&
      COMMENT_MOUNTS.some((m) => m.volume === volume) &&
      !/[\s)]/.test(path),
  );
}

/** The inverse, for a body a run writes back: no browser can load `org/.uploads/…`. */
export function sandboxPathsAsUploads(body: string, orgSlug: string): string {
  return body.replace(/\]\((org\/[^)\s]+)\)/g, (ref, target: string) => {
    const mount = COMMENT_MOUNTS.find((m) => target.startsWith(m.prefix));
    if (!mount) return ref;
    const path = target.slice(mount.prefix.length);
    if (!path || climbsOut(path)) return ref;
    return `](/api/${encodeURIComponent(orgSlug)}/fs/${mount.volume}/read?path=${encodeURIComponent(path)})`;
  });
}

/**
 * The note to append after a rewritten description, so the run knows the
 * `/app/org/.uploads/…` paths `uploadsAsSandboxPaths` just wrote are real
 * files to `Read`, not more prose. Only when the rewrite actually changed something —
 * an unconditional note about attachments that aren't there is noise the
 * model has to rule out. Shared by every sandboxed prompt that shows a task
 * description (the task run itself and its reviewers).
 */
export function sandboxUploadHint(
  original: string,
  rewritten: string,
): string | null {
  return rewritten === original
    ? null
    : "The image and file links in that description are real paths in this sandbox, not URLs — `Read` them. A screenshot the task points at is usually the clearest statement of what it wants.";
}
