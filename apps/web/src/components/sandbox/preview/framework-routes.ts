/**
 * Routes a non-deco site declares through its framework's file-system router,
 * for the page picker of a site with no deco pages (a Next.js storefront, say).
 * They only navigate the preview: none is a CMS page.
 *
 * Only static routes are listed. A dynamic segment (`[slug]`) needs a real
 * value the file tree can't provide, so the site's own links reach those.
 */

export type FrameworkRouter = "pages" | "app";

export interface FrameworkRouteRoot {
  router: FrameworkRouter;
  /** Repo-relative directory, as the sandbox daemon resolves paths. */
  dir: string;
  /** Glob pattern, relative to `dir`, for the files that can declare a route. */
  pattern: string;
}

const PAGE_EXTENSIONS = new Set(["tsx", "ts", "jsx", "js", "mdx"]);

/** Next.js error pages: served on failures, not as a destination. */
const PAGES_ROUTER_ERROR_PAGES = new Set(["404", "500"]);

/** The Next.js router directories, under the project's package path. */
export function frameworkRouteRoots(
  packagePath: string | null | undefined,
): FrameworkRouteRoot[] {
  const base = (packagePath ?? "").trim().replace(/^[/\\]+|[/\\]+$/g, "");
  const join = (dir: string) => (base ? `${base}/${dir}` : dir);
  return [
    { router: "pages", dir: join("pages"), pattern: "**/*" },
    { router: "pages", dir: join("src/pages"), pattern: "**/*" },
    { router: "app", dir: join("app"), pattern: "**/page.*" },
    { router: "app", dir: join("src/app"), pattern: "**/page.*" },
  ];
}

/** `name.ext` → `name` when `ext` is a page extension; otherwise null. */
function stripPageExtension(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return null;
  if (!PAGE_EXTENSIONS.has(fileName.slice(dot + 1))) return null;
  return fileName.slice(0, dot);
}

function isDynamicSegment(segment: string): boolean {
  return segment.includes("[");
}

function pagesRouterPath(segments: string[]): string | null {
  const fileName = segments.at(-1);
  if (!fileName) return null;
  const name = stripPageExtension(fileName);
  // `name.test`, `name.module`: not a page file Next would route on its own.
  if (!name || name.includes(".")) return null;
  const parts = [...segments.slice(0, -1), name];
  if (parts[0] === "api") return null;
  if (parts.length === 1 && PAGES_ROUTER_ERROR_PAGES.has(name)) return null;
  if (parts.some((part) => part.startsWith("_") || isDynamicSegment(part))) {
    return null;
  }
  if (parts.at(-1) === "index") parts.pop();
  return `/${parts.join("/")}`;
}

function appRouterPath(segments: string[]): string | null {
  const fileName = segments.at(-1);
  if (!fileName || stripPageExtension(fileName) !== "page") return null;
  const parts: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    // Private folders, parallel-route slots and intercepting routes never
    // stand for a URL of their own.
    if (segment.startsWith("_") || segment.startsWith("@")) return null;
    if (/^\(\.{1,3}\)/.test(segment)) return null;
    if (isDynamicSegment(segment)) return null;
    // A route group `(name)` organizes files without adding a URL segment.
    if (segment.startsWith("(") && segment.endsWith(")")) continue;
    parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

/** The static URL a router file serves, or null when it serves none. */
export function routePathFromFile(
  router: FrameworkRouter,
  relativeFile: string,
): string | null {
  const segments = relativeFile.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  switch (router) {
    case "pages":
      return pagesRouterPath(segments);
    case "app":
      return appRouterPath(segments);
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
