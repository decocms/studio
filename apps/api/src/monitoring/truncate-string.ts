const TRUNCATION_MARKER = "... [TRUNCATED]";
const MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, "utf8");

/**
 * Truncate a string to fit within maxBytes (UTF-8).
 *
 * If the string exceeds maxBytes, it is cut at a safe character
 * boundary and a truncation marker is appended.
 *
 * The result is NOT valid JSON — it's a raw truncated string with
 * a human-readable marker. This is fine because the ClickHouse
 * `output` column is a plain String, not a JSON column.
 *
 * @param value - The string to truncate
 * @param maxBytes - Maximum byte length (default: 64 KB)
 */
export function truncateString(value: string, maxBytes = 65_536): string {
  // Fast path: for ASCII-only strings (common case), string length equals byte length.
  // For mixed content, check actual byte length only if string length exceeds budget.
  if (
    value.length <= maxBytes &&
    Buffer.byteLength(value, "utf8") <= maxBytes
  ) {
    return value;
  }

  const budget = maxBytes - MARKER_BYTES;
  if (budget <= 0) {
    return TRUNCATION_MARKER.slice(0, maxBytes);
  }

  // Walk characters to find the safe cut point.
  // This avoids splitting multi-byte UTF-8 characters.
  let bytes = 0;
  let cutIndex = 0;
  for (const char of value) {
    const charBytes =
      char.charCodeAt(0) <= 0x7f ? 1 : Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > budget) break;
    bytes += charBytes;
    cutIndex += char.length; // surrogate pairs have length 2
  }

  return value.slice(0, cutIndex) + TRUNCATION_MARKER;
}
