/**
 * Rewrite a `*.localhost` preview URL into a loopback dial target plus the
 * Host header the link daemon's ingress routes by.
 *
 * User-desktop sandboxes serve their preview on `http://<handle>.localhost:
 * <ingressPort>`. Browsers (and curl) special-case `.localhost` subdomains to
 * loopback, but server-side fetch resolves them through getaddrinfo, which
 * returns NXDOMAIN on macOS — so the studio's preview proxy routes
 * (`preview-fetch` / `preview-invoke`) could never reach a linked sandbox.
 * Dialing 127.0.0.1 directly while preserving the original host lets the
 * ingress (`link-daemon/local-ingress.ts`) route by Host as usual.
 *
 * Returns null when the URL isn't a `.localhost` subdomain (fetch it as-is).
 */
export function loopbackPreviewTarget(
  url: string,
): { url: string; hostHeader: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!parsed.hostname.endsWith(".localhost")) return null;
  const hostHeader = parsed.host;
  parsed.hostname = "127.0.0.1";
  return { url: parsed.toString(), hostHeader };
}
