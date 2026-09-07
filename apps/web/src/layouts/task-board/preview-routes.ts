/**
 * The paths a PR's run says it created or edited, read off the PR body.
 *
 * The run authors the PR body itself (`gh pr create`), and its prompt asks it
 * to end that body with a `Preview routes:` list of paths. Concatenated with
 * the deploy preview's origin, that turns one "Open preview" button into the
 * actual pages the change touched.
 *
 * ponytail: parsed from the body rather than persisted on the card. Routes
 * belong to a PR, not to a task (a task can have several, and a re-run replaces
 * them), and `body` is already fetched and on the wire — a column would need a
 * migration, a tool field and its own staleness story. If runs turn out to
 * write the block unreliably, persist it via TASK_BOARD_ITEM_UPDATE instead.
 */

const HEADING = /^\s*preview routes:\s*$/i;
/** `- /path` — a leading `/` is required, so prose bullets don't become links. */
const ROUTE = /^\s*[-*]\s+(\/\S*)\s*$/;

/** No real preview list is longer; caps what one PR body can render. */
const MAX_ROUTES = 20;

export function parsePreviewRoutes(body: string | null | undefined): string[] {
  if (!body) return [];
  const lines = body.split("\n");
  const start = lines.findIndex((l) => HEADING.test(l));
  if (start === -1) return [];

  const routes: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = line.match(ROUTE);
    // Ends at the first non-bullet line, so a later list isn't swallowed.
    if (!match?.[1]) break;
    // `//evil.com` is protocol-relative — it would leave the preview host.
    if (match[1].startsWith("//")) continue;
    if (!routes.includes(match[1])) routes.push(match[1]);
    if (routes.length === MAX_ROUTES) break;
  }
  return routes;
}

/** `https://host/base` + `/path` — one origin, the route's path. */
export function previewRouteUrl(previewUrl: string, route: string): string {
  return new URL(route, previewUrl).toString();
}
