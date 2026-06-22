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
