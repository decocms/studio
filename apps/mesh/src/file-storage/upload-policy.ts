/**
 * Server-side upload policy: object key generation + content-type allowlist
 * + size cap. The active enforcement point is the proxy upload route
 * (`apps/mesh/src/api/routes/file-uploads.ts`), which:
 *   - validates the `Content-Type` header against ALLOWED_CONTENT_TYPES
 *     before reading the body;
 *   - validates the `Content-Length` header against MAX_UPLOAD_BYTES;
 *   - wraps the request stream in a counting transform that aborts the
 *     S3 multipart upload if the actual byte count exceeds the cap (a
 *     client lying about Content-Length still gets rejected mid-stream).
 *
 * The legacy presigned-PUT path (FILE_PRESIGN_UPLOAD) was removed —
 * if/when it comes back, that handler would re-bake these constraints
 * into the signed parameters so S3 rejects mismatched uploads itself.
 */

import { randomUUID } from "node:crypto";

/** 100 MB. Configurable per-config later if needed. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Allowed Content-Types. Mirrored from the picker dialog hint so user error
 * (e.g. ".exe" upload) is rejected before the browser even fires the PUT.
 *
 * `text/html` is intentionally excluded — if the bucket is served from a
 * domain the org also uses for user content, an HTML upload is an XSS
 * vector against the app's own origin.
 *
 * `image/svg+xml` IS allowed despite the well-known SVG-XSS risk. Threat
 * model:
 *   - `<img src="…svg">` (our picker preview, section templates) is safe:
 *     browsers do NOT execute scripts when SVG is loaded as a pure image.
 *   - Top-level navigation, `<object>`, `<iframe>` (e.g. opening the
 *     asset URL in a new tab) DOES execute scripts, but in the CDN
 *     origin (e.g. `decoims.com`), not the app's. As long as the CDN
 *     domain doesn't share cookies/auth with the app, the blast radius
 *     is limited to "the SVG can phone home as the visitor."
 * If you ever serve assets from the same eTLD+1 as the app, remove SVG
 * here or sanitize at upload time.
 */
const ALLOWED_CONTENT_TYPES = new Set([
  // Images
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/avif",
  // Video
  "video/mp4",
  "video/webm",
  "video/quicktime",
  // Audio
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  // Documents
  "application/pdf",
  "application/json",
  "application/zip",
  "text/plain",
  "text/csv",
  "text/markdown",
  // Fonts
  "font/woff",
  "font/woff2",
  "font/ttf",
  "font/otf",
]);

export class UploadRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadRejected";
  }
}

export function assertAllowed(contentType: string, size: number): void {
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new UploadRejected(`Content type "${contentType}" is not allowed.`);
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw new UploadRejected("File size must be a positive number.");
  }
  if (size > MAX_UPLOAD_BYTES) {
    throw new UploadRejected(
      `File too large: ${size} bytes (max ${MAX_UPLOAD_BYTES}).`,
    );
  }
}

/**
 * Sanitize a filename for use as the suffix of an object key. ASCII-fold,
 * lowercase, replace any non-[a-z0-9._-] with `-`, collapse repeats, cap at
 * 80 chars while preserving the file extension when possible.
 */
export function sanitizeFilename(input: string): string {
  const base = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (base.length <= 80) return base || "file";
  // Try to keep the extension.
  const lastDot = base.lastIndexOf(".");
  if (lastDot > 0 && base.length - lastDot <= 10) {
    const ext = base.slice(lastDot);
    return base.slice(0, 80 - ext.length) + ext;
  }
  return base.slice(0, 80);
}

/**
 * Build the object key: `<prefix?>/<yyyy>/<mm>/<uuid>-<sanitized-filename>`.
 * The prefix (already-normalized to end with `/`) comes from the file
 * config. The uuid prevents collisions; the date shards keep S3 LIST
 * responses bounded as the bucket grows.
 */
export function buildObjectKey(params: {
  prefix: string | null;
  filename: string;
}): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear().toString();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const id = randomUUID();
  const safe = sanitizeFilename(params.filename);
  const tail = `${yyyy}/${mm}/${id}-${safe}`;
  return params.prefix ? `${params.prefix}${tail}` : tail;
}
