/**
 * Require both a loopback socket and the configured local browser origin.
 *
 * The origin's host must be loopback: literal `localhost` / `127.0.0.1` /
 * `[::1]`, or any `*.localhost` subdomain. `.localhost` is a reserved TLD
 * (RFC 6761) that always resolves to loopback, so accepting subdomains is safe
 * and covers per-workspace dev hosts (e.g. Conductor serves each branch under
 * `<branch>.localhost`). The loopback-socket check above and the exact
 * `origin === expected.origin` match below still carry the anti-remote/CSRF
 * guarantees — this only widens which configured public URL counts as local.
 */
export function isLocalGithubCliRequest(
  address: string | undefined,
  origin: string | undefined,
  publicUrl: string,
): boolean {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? "")) {
    return false;
  }
  try {
    const expected = new URL(publicUrl);
    const isLoopbackHost =
      ["localhost", "127.0.0.1", "[::1]"].includes(expected.hostname) ||
      expected.hostname.endsWith(".localhost");
    return (
      ["http:", "https:"].includes(expected.protocol) &&
      isLoopbackHost &&
      origin === expected.origin
    );
  } catch {
    return false;
  }
}
