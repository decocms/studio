/**
 * Server-side upload policy: object key generation + content-type allowlist
 * + size cap. Enforced at presign time so the signature itself constrains
 * what the browser can PUT — even if the client lies about content-type or
 * size after the signature is issued, S3 will reject the upload when the
 * signed parameters don't match the actual request.
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
 * vector.
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
