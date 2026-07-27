/**
 * Pure URL rules for the native app's same-origin control server.
 *
 * Packaged native pages are served by local-api itself, so normal relative
 * requests already target the right server and authenticate with its HttpOnly
 * session cookie. The HMR development server proxies the same relative paths
 * to local-api, preserving that exact browser contract without a fetch patch.
 */

export interface LocalApiEndpoint {
  port: number;
  /** Dedicated, unauthenticated sandbox-preview listener. */
  previewPort: number;
  /** Exact upstream Studio deployment configured for this app launch. */
  upstreamUrl: string;
}

/**
 * The control UI and preview use plain `localhost` on different ports. This
 * keeps sandbox application cookies first-party in WKWebView on every
 * supported macOS version. Arbitrary `*.localhost` names do not reliably load
 * inside a bundled app, even when they resolve in the host OS.
 */
export function buildPreviewOrigin(endpoint: LocalApiEndpoint): string {
  return `http://localhost:${endpoint.previewPort}/`;
}

/** Only authenticated, org-scoped file routes are safe to localize. */
export function isProtectedFirstPartyAssetPath(pathname: string): boolean {
  return /^\/api\/[^/]+\/files(?:\/|$)/.test(pathname);
}

/**
 * Convert an absolute protected-file URL emitted by the configured upstream
 * Studio deployment into this app's same-origin URL.
 *
 * The origin comparison is exact. Arbitrary HTTPS images, lookalike hosts,
 * upstream URLs with credentials, and non-file API paths pass through
 * untouched. This narrow rule lets raw browser consumers (`img`, `a`) carry
 * the local HttpOnly session cookie without turning local-api into a generic
 * authenticated asset proxy.
 */
export function resolveProtectedFirstPartyAssetUrl(args: {
  input: string;
  upstreamUrl: string;
  appOrigin: string;
}): string {
  let inputUrl: URL;
  let upstreamOrigin: string;
  let appOrigin: string;
  try {
    inputUrl = new URL(args.input, args.appOrigin);
    const upstream = new URL(args.upstreamUrl);
    const app = new URL(args.appOrigin);
    if (
      inputUrl.username ||
      inputUrl.password ||
      upstream.username ||
      upstream.password ||
      app.username ||
      app.password
    ) {
      return args.input;
    }
    upstreamOrigin = upstream.origin;
    appOrigin = app.origin;
  } catch {
    return args.input;
  }

  if (
    inputUrl.origin !== upstreamOrigin ||
    !isProtectedFirstPartyAssetPath(inputUrl.pathname)
  ) {
    return args.input;
  }

  return `${appOrigin}${inputUrl.pathname}${inputUrl.search}${inputUrl.hash}`;
}

function httpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Resolve the externally reachable Studio origin.
 *
 * In a browser, the page origin already is the public deployment. In native,
 * the page origin is the loopback control server, so copied links and external
 * integrations must use the exact upstream deployment reported by Rust.
 */
export function resolvePublicStudioOrigin(args: {
  browserOrigin: string;
  upstreamUrl?: string | null;
}): string {
  const browserOrigin = httpOrigin(args.browserOrigin) ?? args.browserOrigin;
  if (!args.upstreamUrl) return browserOrigin;
  return httpOrigin(args.upstreamUrl) ?? browserOrigin;
}

/** Join a trusted, root-relative product path to a resolved public origin. */
export function buildPublicStudioUrlAtOrigin(
  origin: string,
  path: string,
): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Public Studio paths must be root-relative");
  }
  return new URL(path, `${origin}/`).href;
}

/** Whether a resolved public Studio origin is a local development server. */
export function isLoopbackStudioOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname;
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}
