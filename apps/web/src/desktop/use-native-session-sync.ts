/**
 * Keeps better-auth's web session in step with the NATIVE auth status on the
 * shared `/login` route. The system-browser PKCE flow (`auth_login`)
 * completes entirely outside the webview — it heals the Keychain and
 * publishes `auth-status-changed`, but nothing tells better-auth's
 * `useSession` (which only re-fetches when its `$sessionSignal` atom is
 * toggled). Without this bridge the user signs in successfully in the
 * browser and returns to a login form that never goes away.
 *
 * Decision logic lives in `native-session-sync.ts` (pure, unit-tested);
 * this hook only wires it between the two external stores. Inert outside
 * the desktop build: the effect early-returns and `useDesktopAuth`'s query
 * is disabled on web.
 */
import { useEffect, useRef } from "react";
import { authClient } from "@/lib/auth-client";
import { isDesktopAppEnvironment } from "@/hooks/use-is-desktop-app";
import { useDesktopAuth } from "@/desktop/use-desktop-auth";
import { shouldNotifyWebSessionRefetch } from "@/desktop/native-session-sync";
import type { AuthStatus } from "@/lib/desktop/tauri-bridge";

export function useNativeSessionSync(): void {
  const auth = useDesktopAuth();
  const session = authClient.useSession();
  const lastNotifiedRef = useRef<AuthStatus | null>(null);
  const status = auth.status;
  const hasWebSession = session.data != null;
  const isWebSessionFetchInFlight = session.isPending;

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- bridges two external stores (Tauri auth status -> better-auth session atom)
  useEffect(() => {
    if (!isDesktopAppEnvironment() || !status) return;
    const notify = shouldNotifyWebSessionRefetch({
      nativeStatus: status,
      lastNotifiedStatus: lastNotifiedRef.current,
      hasWebSession,
      isWebSessionFetchInFlight,
    });
    if (!notify) return;
    lastNotifiedRef.current = status;
    authClient.$store.notify("$sessionSignal");
  }, [status, hasWebSession, isWebSessionFetchInFlight]);
}
