/**
 * Loopback fetch helper. Inside the sandbox both the daemon and the dev
 * server live on the same machine, but the dev server may bind IPv4 only
 * (127.0.0.1, classic Node default) or IPv6 only ([::1], what
 * `Bun.serve`/Vite-on-Bun pick on a dual-stack system). Bun's fetch
 * resolves `localhost` to a single address — the wrong one half the time
 * — so we try [::1] first and fall back to 127.0.0.1.
 *
 * Sequential, not parallel. ECONNREFUSED returns instantly, so the
 * fallback path adds ~1ms in the IPv4-only case and zero in the IPv6
 * case.
 *
 * The fallback is restricted to errors that prove the request never reached
 * the upstream (connection refused, address unreachable). Mid-flight
 * failures like ECONNRESET or AbortError are NOT retried — for non-
 * idempotent proxy requests (POST/PUT/DELETE), retrying after the body has
 * been (partially) sent could trigger the same write twice on the upstream.
 */

const NOT_CONNECTED_CODES = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "ConnectionRefused",
]);

const NOT_CONNECTED_RE =
  /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL|ConnectionRefused/;

function isNotConnected(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Bun puts the syscall code on the error directly (`code: "ConnectionRefused"`);
  // undici / node surface it via `cause.code` (`ECONNREFUSED`).
  const direct = (err as { code?: string }).code;
  if (direct && NOT_CONNECTED_CODES.has(direct)) return true;
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause?.code && NOT_CONNECTED_CODES.has(cause.code)) return true;
  // Fallback to message inspection when neither field is populated.
  return NOT_CONNECTED_RE.test(err.message);
}

export async function fetchLoopback(
  port: number,
  pathAndQuery: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(`http://[::1]:${port}${pathAndQuery}`, init);
  } catch (err) {
    if (!isNotConnected(err)) throw err;
    return await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, init);
  }
}
