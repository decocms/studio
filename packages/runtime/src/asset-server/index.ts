import { devServerProxy } from "./dev-server-proxy";
import { resolve, dirname, join, extname, basename, sep } from "path";

/**
 * Returns appropriate Cache-Control headers based on the file being served.
 *
 * - index.html / SPA fallback: `no-cache` so browsers always revalidate,
 *   preventing stale HTML from referencing old hashed asset URLs after deploys.
 * - Hashed assets (/assets/*): immutable with 1-year max-age since the content
 *   hash in the filename changes on every build.
 * - Everything else: no explicit caching directive (browser defaults apply).
 */
function getAssetCacheHeaders(
  filePath: string,
  indexPath: string,
): Record<string, string> {
  if (filePath === indexPath || basename(filePath) === "index.html") {
    return { "Cache-Control": "no-cache" };
  }

  if (filePath.includes(`${sep}assets${sep}`)) {
    return { "Cache-Control": "public, max-age=31536000, immutable" };
  }

  return {};
}

export interface AssetServerConfig {
  /**
   * Environment mode. Determines whether to proxy to dev server or serve static files.
   * @default process.env.NODE_ENV || "development"
   */
  env?: "development" | "production" | "test";

  /**
   * URL of the Vite dev server for development mode.
   * @default "http://localhost:4000"
   */
  devServerUrl?: string | URL;

  /**
   * Directory containing the built client assets.
   * For production bundles, use `resolveClientDir()` to get the correct path.
   * @default "./dist/client"
   */
  clientDir?: string;

  /**
   * Function to check if a path should be handled by the API server.
   * Return true for API routes, false for static files.
   * If not provided, defaults to serving everything as static.
   */
  isServerPath?: (path: string) => boolean;
}

const DEFAULT_DEV_SERVER_URL = `http://localhost:${process.env.VITE_PORT || "4000"}`;
const DEFAULT_CLIENT_DIR = "./dist/client";

/**
 * Check if a resolved file path is safely within the allowed base directory.
 * Prevents path traversal attacks (e.g., /../../../etc/passwd).
 *
 * @param filePath - The resolved absolute file path
 * @param baseDir - The base directory that files must be within
 * @returns true if the path is safe, false if it's a traversal attempt
 *
 * @example
 * ```ts
 * isPathWithinDirectory("/app/client/style.css", "/app/client") // true
 * isPathWithinDirectory("/etc/passwd", "/app/client") // false
 * ```
 */
export function isPathWithinDirectory(
  filePath: string,
  baseDir: string,
): boolean {
  const resolvedBase = resolve(baseDir);
  const resolvedPath = resolve(filePath);
  return (
    resolvedPath === resolvedBase || resolvedPath.startsWith(resolvedBase + "/")
  );
}

export interface ResolveAssetPathOptions {
  /** The decoded URL pathname (e.g., "/assets/style.css") */
  requestPath: string;
  /** The base directory containing static files */
  clientDir: string;
}

/**
 * Resolve a URL pathname to a file path, with path traversal protection.
 * Returns null if the path is a traversal attempt.
 *
 * @returns File path, or null if unsafe
 *
 * @example
 * ```ts
 * resolveAssetPathWithTraversalCheck({ requestPath: "/style.css", clientDir: "/app/client" })
 * // "/app/client/style.css"
 *
 * resolveAssetPathWithTraversalCheck({ requestPath: "/../../../etc/passwd", clientDir: "/app/client" })
 * // null (blocked)
 * ```
 */
export function resolveAssetPathWithTraversalCheck({
  requestPath,
  clientDir,
}: ResolveAssetPathOptions): string | null {
  const relativePath = requestPath.startsWith("/")
    ? requestPath.slice(1)
    : requestPath;
  const filePath = resolve(clientDir, relativePath);

  // Security: block path traversal attempts
  if (!isPathWithinDirectory(filePath, clientDir)) {
    return null;
  }

  return filePath;
}

/**
 * Resolve the client directory path relative to the running script.
 * Use this for production bundles where the script location differs from CWD.
 *
 * @param importMetaUrl - Pass `import.meta.url` from the calling module
 * @param relativePath - Path relative to the script (default: "../client")
 * @returns Absolute path to the client directory
 *
 * @example
 * ```ts
 * const clientDir = resolveClientDir(import.meta.url, "../client");
 * ```
 */
export function resolveClientDir(
  importMetaUrl: string,
  relativePath = "../client",
): string {
  const scriptUrl = new URL(importMetaUrl);
  const scriptDir = dirname(scriptUrl.pathname);
  return resolve(scriptDir, relativePath);
}

/**
 * TODO(@camudo): make "modes" so we can for example try to serve the asset then fallback to api on miss
 * or try to serve the api call then fallback to asset or index.html on 404
 */

/**
 * Create an asset handler that works with Bun.serve.
 *
 * In development: Proxies requests to Vite dev server
 * In production: Serves static files with SPA fallback
 *
 * @example
 * ```ts
 * const handleAssets = createAssetHandler({
 *   env: process.env.NODE_ENV as "development" | "production",
 *   clientDir: resolveClientDir(import.meta.url),
 *   isServerPath: (path) => path.startsWith("/api/") || path.startsWith("/mcp/"),
 * });
 *
 * Bun.serve({
 *   fetch: async (request) => {
 *     return await handleAssets(request) ?? app.fetch(request);
 *   },
 * });
 * ```
 */
export function createAssetHandler(config: AssetServerConfig = {}) {
  const {
    env = (process.env.NODE_ENV as "development" | "production" | "test") ||
      "development",
    devServerUrl = DEFAULT_DEV_SERVER_URL,
    clientDir = DEFAULT_CLIENT_DIR,
    isServerPath = () => false,
  } = config;

  // Development: Create a proxy handler
  if (env === "development") {
    const proxyHandler = devServerProxy(devServerUrl);

    return async function handleAssets(
      request: Request,
    ): Promise<Response | null> {
      // In dev, proxy everything except server paths
      const url = new URL(request.url);
      if (isServerPath(url.pathname)) {
        return null;
      }

      // Create a minimal Hono context for the proxy
      const fakeContext = {
        req: { raw: request, url: request.url },
      };
      return proxyHandler(fakeContext as any);
    };
  }

  // Production: Serve static files
  return async function handleAssets(
    request: Request,
  ): Promise<Response | null> {
    // Only handle GET requests
    if (request.method !== "GET") {
      return null;
    }

    const requestUrl = new URL(request.url);

    // Decode the pathname to handle URL-encoded characters (e.g., %20 -> space)
    // decodeURIComponent can throw URIError for malformed sequences (e.g., %E0%A4%A)
    let path: string;
    try {
      path = decodeURIComponent(requestUrl.pathname);
    } catch {
      // Malformed URL encoding - return null to let API server handle or return 400
      return null;
    }

    // Let API server handle its routes
    if (isServerPath(path)) {
      return null;
    }

    // Resolve path with traversal check
    const filePath = resolveAssetPathWithTraversalCheck({
      requestPath: path,
      clientDir,
    });
    if (!filePath) {
      return null; // Path traversal attempt blocked
    }

    // Try to serve the index.html file relative to the requested file
    const indexRelativeToFilePath = join(filePath, "index.html");
    // Try to serve the requested file, fall back to index.html for SPA routing
    const indexPath = resolve(clientDir, "index.html");

    const acceptHeader = request.headers.get("accept");
    const acceptsHtml =
      acceptHeader?.includes("text/html") ||
      (acceptHeader?.includes("*/*") &&
        ["", ".html"].includes(extname(filePath)));

    const fallbackPaths = acceptsHtml
      ? [indexRelativeToFilePath, indexPath]
      : [];
    for (const pathToTry of [filePath, ...fallbackPaths]) {
      try {
        const file = Bun.file(pathToTry);
        if (await file.exists()) {
          return new Response(file, {
            headers: getAssetCacheHeaders(pathToTry, indexPath),
          });
        }
      } catch {
        // Continue to next path
      }
    }

    return null;
  };
}
