/**
 * Matches dynamic tokens in page path templates: `:param` (e.g. `/blog/:slug`,
 * `/:my-cat`) and the `*` catch-all (e.g. `/*` for PLPs). The catch-all is
 * reported under the name `"*"`.
 */
export const PATH_PARAM_RE = /:([A-Za-z0-9_-]+)|\*/g;

/** Param names (`:slug`, `*`) in a page path template, deduped, in order. */
export function extractPathParams(path: string): string[] {
  const names: string[] = [];
  for (const match of path.matchAll(PATH_PARAM_RE)) {
    const name = match[1] ?? "*";
    if (!names.includes(name)) names.push(name);
  }
  return names;
}
