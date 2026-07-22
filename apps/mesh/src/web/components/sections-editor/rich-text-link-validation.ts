const SAFE_LINK_PROTOCOLS = new Set([
  "http:",
  "https:",
  "mailto:",
  "tel:",
  "ftp:",
]);

/** Only allow safe URL protocols — blocks `javascript:`, `data:`, `vbscript:`, etc. */
export function isSafeLinkUrl(url: string): boolean {
  // Relative paths and fragment links are always safe.
  if (url.startsWith("/") || url.startsWith(".") || url.startsWith("#")) {
    return true;
  }
  try {
    const parsed = new URL(url, "https://placeholder.invalid");
    return SAFE_LINK_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Normalize user-typed link input: trim whitespace and default bare domains
 * to https ("example.com" → "https://example.com"). Relative paths, fragment
 * links, and URLs that already carry a scheme pass through unchanged.
 */
export function normalizeLinkUrl(raw: string): string {
  const url = raw.trim();
  if (!url) return "";
  if (url.startsWith("/") || url.startsWith(".") || url.startsWith("#")) {
    return url;
  }
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) ? url : `https://${url}`;
}
