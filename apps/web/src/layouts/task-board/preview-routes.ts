/**
 * The paths a PR's run says it created or edited, read off the PR body.
 *
 * Concatenated with the deploy preview's origin, they turn one "Open preview"
 * button into the actual pages the change touched.
 *
 * Two shapes are accepted, both anchored on a `Route:` / `Preview routes:`
 * label so ordinary prose can never become a link: paths on the label's own
 * line (`**Route:** \`/cliente-vip\``, which runs were already writing before
 * the prompt asked for anything), or a bullet list under a bare label. Reading
 * both is what makes the feature work on PRs that predate it.
 *
 * ponytail: parsed from the body rather than persisted on the card. Routes
 * belong to a PR, not to a task (a task can have several, and a re-run replaces
 * them), and `body` is already fetched and on the wire — a column would need a
 * migration, a tool field and its own staleness story, and would know nothing
 * about existing PRs. If runs write these labels unreliably, persist instead.
 */

/** A `Route:` / `Routes:` / `Preview routes:` label, and whatever follows it on
 *  the line. Markdown bold/italic around the label is common, so it's tolerated. */
const LABEL = /^[\s>*_]*(?:preview\s+)?routes?[\s*_]*:[\s*_]*(.*)$/i;
const BULLET = /^\s*[-*]\s+(.*)$/;

/** No real preview list is longer; caps what one PR body can render. */
const MAX_ROUTES = 20;

/** Pull absolute paths out of one line of markdown prose. */
function pathsIn(text: string): string[] {
  return (
    text
      .split(/[\s,;]+/)
      .map((token) =>
        // Markdown wrapping (`code`, [label](…), **bold**) and sentence
        // punctuation sit against the path in real bodies.
        token
          .replace(/^[`("'[*_]+/, "")
          .replace(/[`)"'\]*_.,;:!?]+$/, ""),
      )
      // A single leading slash: a bare `//evil.com` is protocol-relative and
      // would leave the preview host once joined.
      .filter((token) => token.startsWith("/") && !token.startsWith("//"))
  );
}

export function parsePreviewRoutes(body: string | null | undefined): string[] {
  if (!body) return [];
  const lines = body.split("\n");
  const routes: string[] = [];

  const add = (found: string[]) => {
    for (const route of found) {
      if (!routes.includes(route) && routes.length < MAX_ROUTES) {
        routes.push(route);
      }
    }
  };

  for (const [index, line] of lines.entries()) {
    const rest = line.match(LABEL)?.[1];
    if (rest === undefined) continue;
    if (rest.trim()) {
      add(pathsIn(rest));
      continue;
    }
    // A bare label heads a list: take bullets until the first line that isn't
    // one, so a later unrelated list isn't swallowed.
    for (const next of lines.slice(index + 1)) {
      const bullet = next.match(BULLET)?.[1];
      if (bullet === undefined) break;
      add(pathsIn(bullet));
    }
  }
  return routes.slice(0, MAX_ROUTES);
}

/** `https://host/base` + `/path` — one origin, the route's path. */
export function previewRouteUrl(previewUrl: string, route: string): string {
  return new URL(route, previewUrl).toString();
}
