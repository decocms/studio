/**
 * `{handle}` placeholder substitutes; otherwise hostname-prefix. Trailing
 * slash normalized. Invalid URLs fall back to `${base}/${handle}/`.
 */
export function applyPreviewPattern(pattern: string, handle: string): string {
  const base = pattern.replace(/\/+$/, "");
  if (base.includes("{handle}")) {
    return `${base.replace("{handle}", handle)}/`;
  }
  try {
    const u = new URL(base);
    u.hostname = `${handle}.${u.hostname}`;
    return `${u.toString()}/`;
  } catch {
    return `${base}/${handle}/`;
  }
}
