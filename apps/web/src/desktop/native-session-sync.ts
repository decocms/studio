/**
 * Pure decision logic for `use-native-session-sync.ts` — when should the
 * webview ask better-auth to re-fetch `/get-session` because the NATIVE side
 * (Keychain, `auth_status`) says signed in while the web client still holds
 * no session?
 *
 * That divergence is the residual login wedge: the shell bounced to `/login`
 * on a dead cookie, the user completed the system-browser PKCE flow (or the
 * native revalidator re-minted the cookie), the Keychain healed — but
 * better-auth's `useSession` never re-fetches on its own, so the page would
 * sit on the sign-in form forever. Notifying `$sessionSignal` closes the gap.
 *
 * Kept pure (no React, no authClient) so it can be unit-tested per
 * TESTING.md; the hook supplies the inputs.
 */

export interface NativeSessionSyncInput {
  /** Latest `auth_status` payload (referential identity matters — a new
   *  object means a fresh native signal worth acting on). */
  nativeStatus: { signedIn: boolean } | undefined;
  /** The status object the hook last notified for. Comparing by REFERENCE
   *  (not by value) is what bounds the retry: a native `signedIn: true`
   *  paired with a still-dead upstream cookie must not busy-loop
   *  `/get-session` — one notify per fresh native signal, no more. */
  lastNotifiedStatus: object | null;
  /** `authClient.useSession().data` is non-null. */
  hasWebSession: boolean;
  /** A `/get-session` fetch is already in flight — let it land first. */
  isWebSessionFetchInFlight: boolean;
}

export function shouldNotifyWebSessionRefetch(
  input: NativeSessionSyncInput,
): boolean {
  const { nativeStatus } = input;
  if (!nativeStatus?.signedIn) return false;
  if (input.hasWebSession || input.isWebSessionFetchInFlight) return false;
  return input.lastNotifiedStatus !== nativeStatus;
}
