import { performInteractiveLogin } from "../commands/auth/login";
import { getValidSession } from "./get-valid-session";
import { RefreshFailedError } from "./refresh-session";
import { type Session, writeSession } from "./session";

export interface EnsureSessionOptions {
  dataDir: string;
  /** Human-readable name of the action requiring auth, e.g. "Link". */
  intent: string;
  /** Defaults to `process.stdout.isTTY`. */
  isInteractive?: boolean;
  // Injectables (all default to real implementations):
  openBrowser?: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Returns a known-valid session, running interactive login when needed.
 *
 * Behavior:
 *  - Valid session on disk → returned as-is.
 *  - Expired session, refresh succeeds → returned (and rewritten to disk).
 *  - No session or refresh rejected, and TTY is interactive → runs OAuth
 *    login, persists the result, and returns it.
 *  - No session or refresh rejected, and TTY is non-interactive → throws
 *    the standard "No session found" error.
 *  - Transient refresh failure (network/5xx) → throws a user-facing
 *    `Could not refresh session: <reason>...` error. A browser-login
 *    attempt would likely fail the same way; surface the diagnostic instead.
 */
export async function ensureSession(
  opts: EnsureSessionOptions,
): Promise<Session> {
  const isInteractive = opts.isInteractive ?? Boolean(process.stdout.isTTY);

  let existing: Session | null;
  try {
    existing = await getValidSession({
      dataDir: opts.dataDir,
      fetch: opts.fetch,
      now: opts.now,
    });
  } catch (err) {
    if (err instanceof RefreshFailedError && err.kind === "transient") {
      throw new Error(
        `Could not refresh session: ${err.message}. Run \`decocms auth login\` to sign in again.`,
      );
    }
    throw err;
  }
  if (existing) return existing;

  if (!isInteractive) {
    throw new Error(
      "No session found. Run `decocms auth login` first, then re-run the command.",
    );
  }

  console.log(`Not logged in — opening browser to sign in to ${opts.intent}.`);

  const session = await performInteractiveLogin({
    openBrowser: opts.openBrowser,
    fetch: opts.fetch,
  });
  await writeSession(opts.dataDir, session);
  console.log(`Logged in as ${session.user.email ?? session.user.sub}.`);
  return session;
}
