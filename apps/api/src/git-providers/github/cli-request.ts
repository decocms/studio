/** Require both a loopback socket and the configured local browser origin. */
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
    return (
      ["http:", "https:"].includes(expected.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(expected.hostname) &&
      origin === expected.origin
    );
  } catch {
    return false;
  }
}
