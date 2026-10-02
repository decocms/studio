/**
 * Byte delivery for the filesystem read proxies (`/api/:org/fs/…/read` and
 * `/api/_users/fs/…/read`). Shared so the two surfaces cannot drift on the
 * content policy — the org one serves member-authored HTML, and the user one
 * serves files reachable without a session, so both need the same hardening.
 */

import type { Context } from "hono";
import {
  EDITOR_FILE_DIR,
  EDITOR_IMAGE_DIR,
  EDITOR_UPLOAD_VOLUME,
} from "@decocms/shared/editor-uploads";
import { normalizeFsPath } from "@/file-storage/org-fs-path";
import { detectContentType } from "@/object-storage/key-utils";

/** Besides HTML, the types a browser runs script in when one is opened as a page (XML can carry an XHTML root). */
const SCRIPTABLE_TYPES = new Set(["image/svg+xml", "application/xml"]);

/** No script of the file's own runs on our origin in these, so an editor attachment of one may still open in a tab. */
const INLINE_ATTACHMENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

/**
 * A file a task editor attached that must only ever download. Any member can
 * attach any file, and its chip is one click from opening it as a page on our
 * origin. Checked on the normalized path, the one the read actually serves.
 */
export function downloadsOnly(volume: string, path: string): boolean {
  if (volume !== EDITOR_UPLOAD_VOLUME) return false;
  const normalized = normalizeFsPath(path);
  const attached = [EDITOR_FILE_DIR, EDITOR_IMAGE_DIR].some((dir) =>
    normalized.startsWith(`${dir}/`),
  );
  return (
    attached && !INLINE_ATTACHMENT_TYPES.has(detectContentType(normalized))
  );
}

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
  { downloadOnly = false }: { downloadOnly?: boolean } = {},
): Response {
  const contentType = detectContentType(path);
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    /**
     * The type is inferred from the file extension, not from the bytes, and
     * these routes serve user-authored content — one of them without any
     * session at all. Forbid sniffing so a mislabelled upload can never be
     * re-interpreted as something executable on our origin.
     */
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": isPublic
      ? "public, max-age=0, must-revalidate"
      : "private, max-age=0",
  };
  if (downloadOnly) {
    const name = path.split("/").at(-1) ?? "";
    headers["Content-Disposition"] =
      `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
    headers["Content-Security-Policy"] = "sandbox; default-src 'none'";
  } else if (SCRIPTABLE_TYPES.has(contentType)) {
    // An <img> ignores this, and never ran the file's script; opened as a page, the file can't run it now either.
    headers["Content-Security-Policy"] =
      "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'";
  } else if (contentType.startsWith("text/html")) {
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
