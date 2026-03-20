import { extname } from "path";

/**
 * Sanitize a storage key by removing traversal attacks, null bytes, and control characters.
 * Percent-encoded sequences are decoded BEFORE stripping to prevent bypass via encoded payloads.
 */
export function sanitizeKey(key: string): string {
  // Decode percent-encoded sequences first to prevent bypass
  let decoded: string;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    // If decoding fails (malformed percent encoding), use the raw key
    decoded = key;
  }

  const cleaned = decoded
    // Strip null bytes
    .replace(/\0/g, "")
    // Strip control characters (U+0000–U+001F, U+007F)
    .replace(/[\x00-\x1f\x7f]/g, "")
    // Normalize backslashes to forward slashes
    .replace(/\\/g, "/");

  // Resolve path segments to eliminate traversal
  const segments = cleaned.split("/");
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === "..") {
      resolved.pop(); // go up — drop previous segment (or nothing if at root)
    } else if (seg !== "." && seg !== "") {
      resolved.push(seg);
    }
  }

  return resolved.join("/");
}

/**
 * Build a full S3 key with org ID prefix for tenant isolation.
 */
export function buildS3Key(orgId: string, key: string): string {
  const safe = sanitizeKey(key);
  if (!safe) {
    throw new Error("Key is empty after sanitization");
  }
  return `${orgId}/${safe}`;
}

/**
 * Build an S3 prefix for listing objects within an org scope.
 */
export function buildS3Prefix(orgId: string, prefix?: string): string {
  if (!prefix) {
    return `${orgId}/`;
  }
  const safe = sanitizeKey(prefix);
  return `${orgId}/${safe}${safe.endsWith("/") ? "" : "/"}`;
}

/**
 * Strip the org ID prefix from an S3 key, returning the relative key.
 */
export function stripOrgPrefix(orgId: string, s3Key: string): string {
  const prefix = `${orgId}/`;
  if (s3Key.startsWith(prefix)) {
    return s3Key.slice(prefix.length);
  }
  return s3Key;
}

const CONTENT_TYPE_MAP: Record<string, string> = {
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".ts": "text/typescript",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".wasm": "application/wasm",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
};

/**
 * Detect content type from a file key/name based on extension.
 * Falls back to "application/octet-stream" for unknown extensions.
 */
export function detectContentType(key: string): string {
  const ext = extname(key).toLowerCase();
  return CONTENT_TYPE_MAP[ext] ?? "application/octet-stream";
}

const TEXT_CONTENT_TYPES = new Set([
  "application/json",
  "text/html",
  "text/css",
  "application/javascript",
  "text/typescript",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/xml",
  "image/svg+xml",
  "application/yaml",
  "application/toml",
]);

/**
 * Check if a content type represents text data (should be returned as UTF-8 string).
 */
export function isTextContentType(contentType: string): boolean {
  // Strip parameters (e.g. "application/json; charset=utf-8" → "application/json")
  const mediaType = contentType.split(";")[0]!.trim();
  if (TEXT_CONTENT_TYPES.has(mediaType)) return true;
  if (mediaType.startsWith("text/")) return true;
  return false;
}
