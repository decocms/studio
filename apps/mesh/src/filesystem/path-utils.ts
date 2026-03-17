/**
 * Path Utilities for Filesystem Operations
 *
 * Provides path sanitization and S3 key construction with org-level isolation.
 * All user-provided paths are sanitized to prevent directory traversal attacks.
 */

/**
 * Sanitize a user-provided file path to prevent directory traversal and injection attacks.
 *
 * - Strips leading/trailing slashes
 * - Removes `..` path segments
 * - Removes null bytes
 * - Removes non-printable characters
 * - Normalizes multiple consecutive slashes
 * - Rejects empty paths after sanitization
 */
export function sanitizePath(userPath: string): string {
  let path = userPath;

  // Decode percent-encoded sequences first so encoded null bytes / control chars
  // don't survive past the stripping step below.
  try {
    path = decodeURIComponent(path);
  } catch {
    // If decoding fails (malformed %), continue with the raw string
  }

  // Remove null bytes
  path = path.replace(/\0/g, "");

  // Remove non-printable characters (control chars)
  path = path.replace(/[\x00-\x1f\x7f]/g, "");

  // Normalize backslashes to forward slashes
  path = path.replace(/\\/g, "/");

  // Remove leading/trailing slashes
  path = path.replace(/^\/+|\/+$/g, "");

  // Split into segments, remove '..' and '.' segments
  const segments = path
    .split("/")
    .filter((s) => s !== ".." && s !== "." && s !== "");

  // Rejoin and normalize multiple slashes
  path = segments.join("/");

  return path;
}

/**
 * Build an S3 key from an org ID and user-provided path.
 * For the mesh-default shared bucket, the key is prefixed with the org ID.
 *
 * @param orgId - Organization ID (immutable, used as prefix)
 * @param userPath - User-provided file path
 * @returns The full S3 key with org prefix
 */
export function buildS3Key(orgId: string, userPath: string): string {
  const sanitized = sanitizePath(userPath);
  if (!sanitized) {
    throw new Error("Path cannot be empty");
  }
  return `${orgId}/${sanitized}`;
}

/**
 * Build an S3 prefix for listing operations.
 * If no path is provided, returns the org root prefix.
 *
 * @param orgId - Organization ID
 * @param userPath - Optional directory path
 * @returns The S3 prefix for listing
 */
export function buildS3Prefix(orgId: string, userPath?: string): string {
  if (!userPath) {
    return `${orgId}/`;
  }
  const sanitized = sanitizePath(userPath);
  if (!sanitized) {
    return `${orgId}/`;
  }
  // Ensure prefix ends with /
  return `${orgId}/${sanitized}${sanitized.endsWith("/") ? "" : "/"}`;
}

/**
 * Strip the org prefix from an S3 key to get the user-visible path.
 *
 * @param orgId - Organization ID
 * @param s3Key - Full S3 key
 * @returns The user-visible path without org prefix
 */
export function stripOrgPrefix(orgId: string, s3Key: string): string {
  const prefix = `${orgId}/`;
  if (s3Key.startsWith(prefix)) {
    return s3Key.slice(prefix.length);
  }
  return s3Key;
}

/**
 * Detect content type from file extension.
 * Returns a reasonable default for common file types.
 */
export function detectContentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    // Text
    txt: "text/plain",
    md: "text/markdown",
    html: "text/html",
    css: "text/css",
    csv: "text/csv",
    xml: "text/xml",
    // Code
    js: "application/javascript",
    mjs: "application/javascript",
    ts: "text/typescript",
    tsx: "text/typescript",
    jsx: "application/javascript",
    json: "application/json",
    yaml: "application/yaml",
    yml: "application/yaml",
    toml: "application/toml",
    // Images
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    ico: "image/x-icon",
    // Documents
    pdf: "application/pdf",
    // Archives
    zip: "application/zip",
    gz: "application/gzip",
    tar: "application/x-tar",
    // Data
    wasm: "application/wasm",
  };
  return types[ext ?? ""] ?? "application/octet-stream";
}

/**
 * Check if a content type is text-based (content can be returned as utf-8).
 */
export function isTextContentType(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType === "application/javascript" ||
    contentType === "application/yaml" ||
    contentType === "application/toml" ||
    contentType === "application/xml" ||
    contentType === "image/svg+xml"
  );
}
