/**
 * A static connection token is either a bare secret or a full Authorization
 * value such as `Token token=<key>`. The same whitespace check as
 * `buildAuthorizationHeaderValue` decides which: a bare secret is Bearer, and
 * a value that already names a scheme keeps that scheme so callers can send
 * `${tokenType} ${accessToken}` without prefixing Bearer twice.
 */
export function presentStaticConnectionToken(token: string): {
  tokenType: string;
  accessToken: string;
} {
  const trimmed = token.trim();
  const separator = trimmed.search(/\s/);
  if (separator === -1) {
    return { tokenType: "Bearer", accessToken: trimmed };
  }
  const tokenType = trimmed.slice(0, separator);
  const accessToken = trimmed.slice(separator + 1).trim();
  if (!tokenType || !accessToken) {
    return { tokenType: "Bearer", accessToken: trimmed };
  }
  return { tokenType, accessToken };
}
