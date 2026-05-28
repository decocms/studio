import { RefreshFailedError, refreshSession } from "./refresh-session";
import { readSession, type Session, writeSession } from "./session";

/** Treat a session as expired this many seconds before its declared expiry, to avoid races. */
const EXPIRY_SKEW_SECONDS = 60;

export interface GetValidSessionOptions {
  dataDir: string;
  fetch?: typeof fetch;
  /** Returns the current time in milliseconds. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Reads the session from disk and silently refreshes it when expired.
 *
 * Returns null when:
 *  - no session file exists, OR
 *  - the session is expired and has no refresh token, OR
 *  - the refresh token is rejected by the server (invalid_grant).
 *
 * Throws RefreshFailedError("transient") when the refresh request fails
 * for network/server reasons (5xx, fetch rejection) — callers can decide
 * whether to surface this to the user or attempt interactive login.
 *
 * Never opens a browser.
 */
export async function getValidSession(
  opts: GetValidSessionOptions,
): Promise<Session | null> {
  const session = await readSession(opts.dataDir);
  if (!session) return null;

  const now = opts.now ?? Date.now;
  if (!isExpired(session, now())) return session;

  try {
    const refreshed = await refreshSession(session, opts.fetch, now);
    await writeSession(opts.dataDir, refreshed);
    return refreshed;
  } catch (err) {
    if (err instanceof RefreshFailedError && err.kind === "invalid_grant") {
      return null;
    }
    throw err;
  }
}

function isExpired(session: Session, nowMs: number): boolean {
  if (session.expiresAt === undefined) return false;
  const nowSeconds = Math.floor(nowMs / 1000);
  return session.expiresAt - EXPIRY_SKEW_SECONDS < nowSeconds;
}
