import { orgFsSandboxPath } from "@/file-storage/mount/provisioning";

/**
 * Point a task description's uploaded files at the sandbox, not at Studio.
 *
 * The markdown editor stores an upload as a link to the org filesystem's HTTP
 * read endpoint (`/api/:org/fs/:volume/read?path=…`, see
 * `apps/web/src/components/markdown-editor/uploads.ts`). That URL is relative
 * and cookie-authenticated, so it means nothing inside a sandbox: an agent
 * handed the raw description sees `![image.png](/api/…)` and has no way to
 * fetch it. It reads as text and gets treated as one — the DANI-19 run
 * described an image it had never seen.
 *
 * The same bytes are already mounted in the pod (`org/.uploads/…`), so the fix
 * is to rewrite the URL to that path. `Read` renders a PNG visually, so the
 * model actually looks at the screenshot the task is about.
 *
 * Sandboxed runs ONLY — a hosted harness has no org-fs mount, and there the
 * original URL is at least a link a human can click.
 */
export function uploadsAsSandboxPaths(description: string): string {
  return description.replace(
    // The editor writes `?path=` as the whole query, so everything up to the
    // closing paren (or whitespace) is the encoded path.
    /\/api\/[^/\s)]+\/fs\/([^/\s)]+)\/read\?path=([^)\s]+)/g,
    (url, encodedVolume: string, encodedPath: string) => {
      let volume: string;
      let path: string;
      try {
        volume = decodeURIComponent(encodedVolume);
        path = decodeURIComponent(encodedPath);
      } catch {
        return url;
      }
      // Checked on the DECODED value: `%2F` hides a climb-out slash from the capture.
      const climbsOut = (part: string) =>
        part.startsWith("/") || part.split("/").includes("..");
      if (climbsOut(volume) || climbsOut(path)) return url;
      return orgFsSandboxPath(volume, path);
    },
  );
}

/**
 * The note to append after a rewritten description, so the run knows the
 * `org/.uploads/…` paths `uploadsAsSandboxPaths` just wrote are real files to
 * `Read`, not more prose. Only when the rewrite actually changed something —
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
