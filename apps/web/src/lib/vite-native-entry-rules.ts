const RESERVED_NATIVE_PATH_PREFIXES = [
  "/api",
  "/mcp",
  "/oauth-proxy",
  "/.well-known",
  "/org",
  "/_auth",
  "/_local",
  "/_sandbox",
  "/threads",
  "/models",
  "/health",
  "/metrics",
] as const;

function isReservedNativePath(pathname: string): boolean {
  return RESERVED_NATIVE_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function acceptsHtml(accept: string | undefined): boolean {
  return (
    accept
      ?.split(",")
      .some((value) => value.trim().toLowerCase().startsWith("text/html")) ??
    false
  );
}

/**
 * Mirrors local-api's packaged SPA fallback at the Vite asset boundary.
 *
 * Only GET/HEAD HTML navigations outside native API namespaces may resolve to
 * the native entry. API requests must reach Vite's proxy unchanged, even when
 * a caller advertises `Accept: text/html`.
 */
export function shouldServeNativeEntryInDev(input: {
  method: string | undefined;
  url: string | undefined;
  accept: string | undefined;
}): boolean {
  const method = input.method?.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  if (!acceptsHtml(input.accept) || !input.url) return false;

  let pathname: string;
  try {
    pathname = new URL(input.url, "http://native.local").pathname;
  } catch {
    return false;
  }
  return !isReservedNativePath(pathname);
}
