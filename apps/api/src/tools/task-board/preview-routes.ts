/** No real preview list is longer — caps what one update can store. */
const MAX_ROUTES = 20;

/**
 * The paths a task's work created or edited, as the card can safely use them.
 *
 * Validated here rather than trusted from the caller: each one is joined onto
 * a deploy-preview origin (`new URL(route, previewUrl)`, in the card's
 * `PreviewButton`) and rendered as a link a reviewer clicks, so a value that
 * isn't a plain absolute path (`//host`, `https://…`, a relative file path)
 * has to be dropped — it would point the button somewhere other than the
 * preview.
 *
 * `startsWith("//")` alone isn't enough: the WHATWG URL parser first strips
 * ASCII tab/CR/LF and rewrites `\` to `/` before resolving, so `"/\evil.com"`
 * and `"/\t/evil.com"` both become the protocol-relative `"//evil.com"` once
 * `new URL()` sees them — landing the "Open preview" button on an attacker's
 * origin instead of the deploy preview. Applying that same normalization here
 * first is what makes the leading-`//` check catch them too.
 */
export function normalizePreviewRoutes(
  routes: string[] | undefined,
): string[] | undefined {
  if (routes === undefined) return undefined;
  const cleaned: string[] = [];
  for (const raw of routes) {
    const route = raw
      .trim()
      .replace(/[\t\r\n]/g, "")
      .replace(/\\/g, "/");
    if (!route.startsWith("/") || route.startsWith("//")) continue;
    if (!cleaned.includes(route)) cleaned.push(route);
    if (cleaned.length === MAX_ROUTES) break;
  }
  return cleaned;
}
