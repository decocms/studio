/**
 * Routes a site declares through its framework's file-system router, for the
 * preview's page picker. They only navigate the preview: none is a CMS page.
 *
 * The framework comes from the app's `package.json`, never from folder names
 * alone: a plain Vite app's `src/pages/Home.tsx` is a component, not `/Home`.
 * Only static routes are listed. A dynamic segment (`[slug]`, `$slug`) needs a
 * real value the file tree can't provide, so the site's own links reach those.
 */

export type RouterFramework = "next" | "tanstack";

export type FrameworkRouter = "next-pages" | "next-app" | "tanstack";

export interface FrameworkRouteRoot {
  router: FrameworkRouter;
  /** Repo-relative directory, as the sandbox daemon resolves paths. */
  dir: string;
  /** Glob pattern, relative to `dir`, for the files that can declare a route. */
  pattern: string;
}

const NEXT_PACKAGES = ["next"];
const TANSTACK_PACKAGES = [
  "@tanstack/react-router",
  "@tanstack/react-start",
  "@tanstack/solid-router",
  "@tanstack/solid-start",
];

const PAGE_EXTENSIONS = new Set(["tsx", "ts", "jsx", "js", "mdx"]);
/** TanStack route files without JSX are server handlers (JSON, redirects). */
const TANSTACK_PAGE_EXTENSIONS = new Set(["tsx", "jsx"]);

/** Next.js error pages: served on failures, not as a destination. */
const PAGES_ROUTER_ERROR_PAGES = new Set(["404", "500"]);

function dependencyNames(packageJson: unknown): Set<string> {
  const names = new Set<string>();
  if (!packageJson || typeof packageJson !== "object") return names;
  const pkg = packageJson as Record<string, unknown>;
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = pkg[field];
    if (deps && typeof deps === "object" && !Array.isArray(deps)) {
      for (const name of Object.keys(deps)) names.add(name);
    }
  }
  return names;
}

/** The file-system router the app's `package.json` depends on, if any. */
export function detectRouterFramework(
  packageJson: unknown,
): RouterFramework | null {
  const deps = dependencyNames(packageJson);
  if (NEXT_PACKAGES.some((name) => deps.has(name))) return "next";
  if (TANSTACK_PACKAGES.some((name) => deps.has(name))) return "tanstack";
  return null;
}

/** Join the project's package path with a repo-relative path. */
export function packageRepoPath(
  packagePath: string | null | undefined,
  relative: string,
): string {
  const base = (packagePath ?? "").trim().replace(/^[/\\]+|[/\\]+$/g, "");
  return base ? `${base}/${relative}` : relative;
}

/** The router directories of `framework`, under the project's package path. */
export function frameworkRouteRoots(
  framework: RouterFramework,
  packagePath: string | null | undefined,
): FrameworkRouteRoot[] {
  const join = (dir: string) => packageRepoPath(packagePath, dir);
  switch (framework) {
    case "next":
      return [
        { router: "next-pages", dir: join("pages"), pattern: "**/*" },
        { router: "next-pages", dir: join("src/pages"), pattern: "**/*" },
        { router: "next-app", dir: join("app"), pattern: "**/page.*" },
        { router: "next-app", dir: join("src/app"), pattern: "**/page.*" },
      ];
    case "tanstack":
      return [{ router: "tanstack", dir: join("src/routes"), pattern: "**/*" }];
    default: {
      const unhandled: never = framework;
      throw new Error(`Unknown framework: ${String(unhandled)}`);
    }
  }
}

/** `name.ext` → [`name`, `ext`]; null without an extension. */
function splitExtension(fileName: string): [string, string] | null {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return null;
  return [fileName.slice(0, dot), fileName.slice(dot + 1)];
}

function nextPagesPath(segments: string[]): string | null {
  const parts = splitExtension(segments.at(-1) ?? "");
  if (!parts || !PAGE_EXTENSIONS.has(parts[1])) return null;
  const [name] = parts;
  // `name.test`, `name.module`: not a page file Next would route on its own.
  if (name.includes(".")) return null;
  const tokens = [...segments.slice(0, -1), name];
  if (tokens[0] === "api") return null;
  if (tokens.length === 1 && PAGES_ROUTER_ERROR_PAGES.has(name)) return null;
  if (tokens.some((token) => token.startsWith("_") || token.includes("["))) {
    return null;
  }
  if (tokens.at(-1) === "index") tokens.pop();
  return `/${tokens.join("/")}`;
}

function nextAppPath(segments: string[]): string | null {
  const parts = splitExtension(segments.at(-1) ?? "");
  if (!parts || parts[0] !== "page" || !PAGE_EXTENSIONS.has(parts[1])) {
    return null;
  }
  const tokens: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    // Private folders, parallel-route slots and intercepting routes never
    // stand for a URL of their own.
    if (segment.startsWith("_") || segment.startsWith("@")) return null;
    if (/^\(\.{1,3}\)/.test(segment)) return null;
    if (segment.includes("[")) return null;
    // A route group `(name)` organizes files without adding a URL segment.
    if (segment.startsWith("(") && segment.endsWith(")")) continue;
    tokens.push(segment);
  }
  return `/${tokens.join("/")}`;
}

/** Split a TanStack flat file name on `.`, keeping `[.]`-escaped dots. */
function tanstackTokens(name: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let escaped = false;
  for (const char of name) {
    if (char === "[") escaped = true;
    else if (char === "]") escaped = false;
    if (char === "." && !escaped) {
      tokens.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  tokens.push(current);
  return tokens;
}

function tanstackPath(segments: string[]): string | null {
  const parts = splitExtension(segments.at(-1) ?? "");
  if (!parts || !TANSTACK_PAGE_EXTENSIONS.has(parts[1])) return null;
  const tokens = [...segments.slice(0, -1), ...tanstackTokens(parts[0])].filter(
    Boolean,
  );
  if (tokens.at(-1) === "lazy") tokens.pop();
  const last = tokens.at(-1);
  if (!last || last === "__root") return null;
  // `-` prefixes files and folders the router ignores; `_name` alone is a
  // pathless layout, which wraps routes without being one.
  if (tokens.some((token) => token.startsWith("-"))) return null;
  if (last.startsWith("_")) return null;
  if (last === "index" || last === "route") tokens.pop();
  const path: string[] = [];
  for (const token of tokens) {
    if (token.includes("$")) return null;
    if (token.startsWith("_")) continue;
    if (token.startsWith("(") && token.endsWith(")")) continue;
    // `name_` opts out of nesting under `name`; the URL keeps `name`.
    const segment = token.replace(/_$/, "").replace(/[[\]]/g, "");
    if (segment) path.push(segment);
  }
  return `/${path.join("/")}`;
}

/** The static URL a router file serves, or null when it serves none. */
export function routePathFromFile(
  router: FrameworkRouter,
  relativeFile: string,
): string | null {
  const segments = relativeFile.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  switch (router) {
    case "next-pages":
      return nextPagesPath(segments);
    case "next-app":
      return nextAppPath(segments);
    case "tanstack":
      return tanstackPath(segments);
    default: {
      const unhandled: never = router;
      throw new Error(`Unknown router: ${String(unhandled)}`);
    }
  }
}

/**
 * The static routes in `files` (repo-relative paths the daemon listed under
 * each root), deduplicated and sorted with `/` first.
 */
export function frameworkRoutesFromFiles(
  listings: { root: FrameworkRouteRoot; files: string[] }[],
): string[] {
  const routes = new Set<string>();
  for (const { root, files } of listings) {
    const prefix = `${root.dir}/`;
    for (const file of files) {
      if (!file.startsWith(prefix)) continue;
      const path = routePathFromFile(root.router, file.slice(prefix.length));
      if (path) routes.add(path);
    }
  }
  return [...routes].sort((a, b) =>
    a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b),
  );
}
