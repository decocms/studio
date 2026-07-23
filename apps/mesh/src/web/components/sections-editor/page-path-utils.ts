/** Normalize trailing slashes; root stays "/". */
export function normalizePagePath(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

/**
 * Trim surrounding slashes from a path-param value: the template supplies the
 * leading `/`, so a typed `/sabonetes/x` fills as `sabonetes/x`. Internal
 * slashes are kept (a catch-all value can be multi-segment).
 */
export function stripSurroundingSlashes(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

/** Reject protocol-relative paths, parent segments, and non-path values. */
export function isValidPagePath(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed.startsWith("/")) return false;
  if (trimmed.startsWith("//")) return false;
  if (trimmed.includes("..")) return false;
  if (trimmed.includes("\\")) return false;
  return true;
}

export function validatePagePath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return "Path is required.";
  if (!isValidPagePath(trimmed)) {
    return "Path must start with / and must not contain .. or //.";
  }
  return null;
}

/**
 * Matches dynamic tokens in page path templates: `:param` (e.g. `/blog/:slug`,
 * `/:my-cat`) and the `*` catch-all (e.g. `/*` for PLPs). The catch-all is
 * reported under the name `"*"`.
 */
const PATH_PARAM_RE = /:([A-Za-z0-9_-]+)|\*/g;

/** Param names (`:slug`, `*`) in a page path template, deduped, in order. */
export function extractPathParams(path: string): string[] {
  const names: string[] = [];
  for (const match of path.matchAll(PATH_PARAM_RE)) {
    const name = match[1] ?? "*";
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export type PathToken =
  | { type: "text"; text: string }
  | { type: "param"; name: string };

/**
 * Expand optional literal segments `{x}?` to their inner literal, treated as
 * always present (e.g. `/{granado/}?*` → `/granado/*`, `/bf{/70-off}?` →
 * `/bf/70-off`). Deco/TanStack route templates use this for optional path
 * segments; the preview always renders the fuller form so the URL resolves.
 */
function expandOptionalSegments(path: string): string {
  return path.replace(/\{([^{}]*)\}\?/g, "$1");
}

/** Split a path template into static text and `:param`/`*` tokens, in order. */
export function splitPathTemplate(path: string): PathToken[] {
  path = expandOptionalSegments(path);
  const tokens: PathToken[] = [];
  let last = 0;
  for (const match of path.matchAll(PATH_PARAM_RE)) {
    if (match.index > last) {
      tokens.push({ type: "text", text: path.slice(last, match.index) });
    }
    tokens.push({ type: "param", name: match[1] ?? "*" });
    last = match.index + match[0].length;
  }
  if (last < path.length) {
    tokens.push({ type: "text", text: path.slice(last) });
  }
  return tokens;
}

/** Replace `:param`/`*` tokens with URL-encoded values; unset/empty values keep the token. */
export function fillPathTemplate(
  path: string,
  values: Record<string, string>,
): string {
  return expandOptionalSegments(path).replace(
    PATH_PARAM_RE,
    (token, name?: string) => {
      const value = values[name ?? "*"]?.trim();
      if (!value) return token;
      if (name !== undefined) return encodeURIComponent(value);
      // The `*` catch-all may span multiple segments (e.g. `category/shoes`):
      // keep `/` separators, encode each segment, drop empty ones (leading or
      // doubled slashes in the typed value).
      const filled = value
        .split("/")
        .filter(Boolean)
        .map(encodeURIComponent)
        .join("/");
      return filled || token;
    },
  );
}
