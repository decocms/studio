/**
 * Redirect URI policy for the OAuth authorization endpoint.
 *
 * The endpoint hands out an authorization code that, in this runtime, encodes
 * the upstream provider token. A redirect target the server cannot tie back to
 * a registered client is an open redirect carrying a live credential, so these
 * rules stay literal.
 */

/**
 * Hosts that always resolve to the machine running the user agent, so a
 * redirect there never leaves the client. Covers the RFC 8252 §7.3 loopback IP
 * literals and the `localhost` names RFC 6761 reserves for the same purpose.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1" ||
    host === "localhost" ||
    host.endsWith(".localhost")
  );
}

/**
 * Compare a requested `redirect_uri` against one the client registered.
 *
 * Exact string comparison per RFC 6749 §3.1.2.2. No prefix, substring or
 * "same host" relaxation. RFC 8252 §7.3 is the one exception: a native client
 * binds an ephemeral loopback port it cannot know at registration time, so the
 * port alone may differ for loopback URIs.
 */
export function redirectUriMatchesRegistered(
  requested: string,
  registered: string,
): boolean {
  if (requested === registered) {
    return true;
  }

  let requestedUrl: URL;
  let registeredUrl: URL;
  try {
    requestedUrl = new URL(requested);
    registeredUrl = new URL(registered);
  } catch {
    return false;
  }

  if (
    !isLoopbackHost(requestedUrl.hostname) ||
    !isLoopbackHost(registeredUrl.hostname)
  ) {
    return false;
  }

  return (
    requestedUrl.protocol === registeredUrl.protocol &&
    requestedUrl.hostname.toLowerCase() ===
      registeredUrl.hostname.toLowerCase() &&
    requestedUrl.pathname === registeredUrl.pathname &&
    requestedUrl.search === registeredUrl.search &&
    requestedUrl.hash === registeredUrl.hash
  );
}

/**
 * Match a host against an allowlist suffix on a label boundary, so
 * `decocms.com` covers `github-mcp.decocms.com` but neither `evildecocms.com`
 * nor `decocms.com.attacker.io`.
 */
export function hostMatchesSuffix(hostname: string, suffix: string): boolean {
  const host = hostname.toLowerCase();
  const allowed = suffix.trim().toLowerCase().replace(/^\.+/, "");
  if (!allowed) {
    return false;
  }
  return host === allowed || host.endsWith(`.${allowed}`);
}

/**
 * Server-level allowlist check. `https` URIs must land on an allowed host.
 * `http` is accepted only for loopback, where there is no network to
 * intercept. Every other scheme, including the custom schemes native clients
 * register, has no host to check and is rejected.
 */
export function satisfiesAllowedRedirectHosts(
  uri: string,
  allowedHosts: readonly string[],
): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }

  if (url.protocol === "http:") {
    return isLoopbackHost(url.hostname);
  }
  if (url.protocol !== "https:") {
    return false;
  }
  return allowedHosts.some((suffix) => hostMatchesSuffix(url.hostname, suffix));
}
