/** Normalize trailing slashes; root stays "/". */
export function normalizePagePath(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

/** Reject protocol-relative paths, parent segments, and non-path values. */
export function isValidPagePath(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed.startsWith("/")) return false;
  if (trimmed.startsWith("//")) return false;
  if (trimmed.includes("..")) return false;
  if (trimmed.includes("\\")) return false;
  return true;
}

export function validatePagePath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return "Path is required.";
  if (!isValidPagePath(trimmed)) {
    return "Path must start with / and must not contain .. or //.";
  }
  return null;
}
