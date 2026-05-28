/**
 * Pull the sandbox `<handle>` out of an HTTP Host header for the local
 * ingress. The daemon serves `<handle>.localhost[:port]` and proxies to the
 * sandbox keyed by handle. Anything else (bare `localhost`, public hostnames,
 * multi-level subdomains, IPv6, empty) returns null so the ingress can 404.
 */
export function parseHandleFromHost(
  host: string | null | undefined,
): string | null {
  if (typeof host !== "string" || host.length === 0) return null;

  // Strip port.
  const colon = host.lastIndexOf(":");
  // IPv6 literals are `[::1]:port` — bracketed. Reject them outright; the
  // local ingress is `*.localhost` only.
  if (host.startsWith("[")) return null;
  const hostname = colon >= 0 ? host.slice(0, colon) : host;

  // Strip trailing dot (FQDN form).
  const normalized = hostname.replace(/\.$/, "").toLowerCase();

  // Must end in ".localhost" and have exactly one extra label.
  const suffix = ".localhost";
  if (!normalized.endsWith(suffix)) return null;
  const handle = normalized.slice(0, -suffix.length);
  if (handle.length === 0) return null; // bare "localhost"
  if (handle.includes(".")) return null; // multi-level subdomain

  return handle;
}
