/**
 * Rewrite an outbound MCP URL to an in-cluster address.
 *
 * Some downstream MCP servers (e.g. the 700-tool VTEX MCP) run on our own
 * cluster but are addressed by their public `*.deco.site` hostname. Reaching
 * them that way sends every tool call out through the public ingress and back,
 * which bills as egress. When the map has an entry for the URL's host, we swap
 * the origin (scheme + host + port) for the in-cluster one and keep the path —
 * the request never leaves the cluster.
 *
 * The map is empty by default, so this is a no-op unless `MCP_INTERNAL_HOST_MAP`
 * is configured. Keys are exact hostnames; values are an origin, with `http://`
 * assumed when no scheme is given.
 */
export function internalizeMcpUrl(
  url: URL,
  hostMap: Record<string, string>,
): URL {
  const target = hostMap[url.hostname];
  if (!target) return url;

  // ponytail: exact-host match only. If per-port routing is ever needed, key
  // the map on `host` (hostname:port) instead.
  const origin = target.includes("://") ? target : `http://${target}`;
  const internal = new URL(url.toString());
  const base = new URL(origin);
  internal.protocol = base.protocol;
  internal.host = base.host; // host = hostname + port, so this carries the port
  return internal;
}
