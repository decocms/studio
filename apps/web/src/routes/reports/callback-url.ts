/** Better Auth (1.4.22) validates a RELATIVE `callbackURL` against this exact
 *  pattern — `matchesOriginPattern`'s `allowRelativePaths` branch in
 *  `packages/better-auth/src/auth/trusted-origins.ts`:
 *
 *    /^\/(?!\/|\\|%2f|%5c)[\w\-.\+/@]*(?:\?[\w\-.\+/=&%@]*)?$/
 *
 *  Neither `:` nor `#` appears in either character class, and the pattern is
 *  anchored. So a shared deck link — `?share_id=<domain>:<slide>:<id>` — and
 *  ANY `#anchor` were rejected before the provider redirect even started:
 *  `signIn.social` threw "Invalid callbackURL", the button looked dead, and
 *  people clicked it again (98 events across 19 people in 30 days).
 *
 *  Kept relative on purpose: an absolute URL would pass only while
 *  `getOrigin(url)` string-equals the server's `baseUrl`, which silently
 *  breaks on a trailing slash or a preview host. */
const RELATIVE_CALLBACK_RE =
  /^\/(?!\/|\\|%2f|%5c)[\w\-.\+/@]*(?:\?[\w\-.\+/=&%@]*)?$/;

export function callbackUrl(domain: string): string {
  const path = `/report/${encodeURIComponent(domain)}`;
  // A path we cannot vouch for (an encoded domain leaves a `%`, which the
  // pattern's path class excludes) is worse than losing the destination.
  const safePath = RELATIVE_CALLBACK_RE.test(path) ? path : "/";
  if (typeof window === "undefined") return safePath;
  // Re-serializing through URLSearchParams percent-encodes the raw `:` a share
  // link carries, and share_id/utm_* survive — `track.ts` reads them to
  // attribute the signup to the deck that drove it.
  const query = new URLSearchParams(window.location.search).toString();
  // The hash is dropped: nothing reads it back (it is a share-link anchor), and
  // no encoding of it can satisfy an anchored pattern with no `#` in it.
  const candidate = query ? `${safePath}?${query}` : safePath;
  return RELATIVE_CALLBACK_RE.test(candidate) ? candidate : safePath;
}
