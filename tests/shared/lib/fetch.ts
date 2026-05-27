/**
 * Authenticated `fetch` shared by the Docker-Compose-backed test suites
 * (resilience, multi-pod). Both speak to a real Studio HTTP server with
 * Better Auth: Origin header is mandatory for CSRF, and auth is either a
 * bearer API key or a session cookie.
 *
 * Per-suite wrappers pin the base URL (single host for resilience,
 * per-pod for multi-pod). This module owns the header-building logic so
 * the two stacks can't drift on what Better Auth expects.
 */

/** Must match BETTER_AUTH_URL in the compose stacks (both pin localhost:3000). */
const ORIGIN = "http://localhost:3000";

export interface AuthOpts {
  apiKey?: string;
  cookie?: string;
}

export interface FetchWithAuthOpts extends RequestInit {
  auth?: AuthOpts;
}

/**
 * `fetch` a path under `baseUrl`, attaching Origin (always) and
 * Authorization/Cookie headers when `auth` is supplied.
 */
export async function fetchWithAuth(
  baseUrl: string,
  path: string,
  opts: FetchWithAuthOpts = {},
): Promise<Response> {
  const { auth, headers: extraHeaders, ...init } = opts;

  const headers = new Headers(extraHeaders);
  if (!headers.has("Origin")) headers.set("Origin", ORIGIN);
  if (auth?.apiKey) headers.set("Authorization", `Bearer ${auth.apiKey}`);
  if (auth?.cookie) headers.set("Cookie", auth.cookie);

  return fetch(`${baseUrl}${path}`, { ...init, headers });
}
