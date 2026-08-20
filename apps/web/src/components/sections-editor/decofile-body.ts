/**
 * Decide whether a 200 from `/.decofile` is actually a decofile.
 *
 * A repo that doesn't use the deco framework for sites still answers that route:
 * a plain Vite/SPA dev server (Studio itself, previewed on a coding agent) hands
 * back `index.html` with a 200. Treating any 200 as a decofile is what made such
 * repos look like deco sites. A decofile is a JSON object keyed by block id, so
 * "parses as a JSON object" is the discriminator — HTML fails it.
 */
export function parseDecofileBody(
  body: string,
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}
