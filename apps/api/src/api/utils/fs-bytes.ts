/**
 * Byte delivery for the filesystem read proxies (`/api/:org/fs/…/read` and
 * `/api/_users/fs/…/read`). Shared so the two surfaces cannot drift on the
 * content policy — the org one serves member-authored HTML, and the user one
 * serves files reachable without a session, so both need the same hardening.
 */

import type { Context } from "hono";
import { detectContentType } from "@/object-storage/key-utils";

/**
 * Stream file bytes with the right content-type and, for user-authored HTML
 * (deck previews, generated pages), a sandbox CSP so the top-level document
 * runs with an opaque origin — its scripts can't make credentialed same-origin
 * calls. allow-modals keeps window.print() working for the deck PDF-export
 * path. Public files revalidate (no shared caching past an unpublish); private
 * files stay uncacheable.
 */
export function fsByteResponse(
  c: Context,
  bytes: Uint8Array,
  path: string,
  isPublic: boolean,
): Response {
  const contentType = detectContentType(path);
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": isPublic
      ? "public, max-age=0, must-revalidate"
      : "private, max-age=0",
  };
  if (contentType.startsWith("text/html")) {
    /**
     * TEMP(demo 2026-07-08, REVERT): allow-same-origin gives previews a real
     * origin so nested frame-ancestors checks pass — but re-enables
     * credentialed same-origin API calls from user HTML.
     */
    headers["Content-Security-Policy"] =
      "sandbox allow-scripts allow-modals allow-same-origin allow-downloads";
  }
  return c.body(Buffer.from(bytes), 200, headers);
}
