/** No real preview list is longer — caps what one update can store. */
const MAX_ROUTES = 20;

/**
 * The paths a task's work created or edited, as the card can safely use them.
 *
 * Validated here rather than trusted from the caller: each one is joined onto
 * a deploy-preview origin and rendered as a link, so a value that isn't a plain
 * absolute path (`//host`, `https://…`, a relative file path) has to be dropped
 * — it would point the button somewhere other than the preview.
 */
export function normalizePreviewRoutes(
  routes: string[] | undefined,
): string[] | undefined {
  if (routes === undefined) return undefined;
  const cleaned: string[] = [];
  for (const raw of routes) {
    const route = raw.trim();
    if (!route.startsWith("/") || route.startsWith("//")) continue;
    if (!cleaned.includes(route)) cleaned.push(route);
    if (cleaned.length === MAX_ROUTES) break;
  }
  return cleaned;
}
