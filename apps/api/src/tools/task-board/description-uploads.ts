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
    (url, volume: string, encodedPath: string) => {
      let path: string;
      try {
        path = decodeURIComponent(encodedPath);
      } catch {
        return url;
      }
      // A description is user-written, and this path becomes a filesystem read
      // inside the pod. Anything that could climb out of the mount keeps its
      // original URL rather than resolving somewhere it shouldn't.
      if (path.startsWith("/") || path.split("/").includes("..")) return url;
      return orgFsSandboxPath(decodeURIComponent(volume), path);
    },
  );
}
