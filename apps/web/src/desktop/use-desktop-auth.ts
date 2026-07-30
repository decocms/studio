/**
 * Auth gate state for the desktop shell. Wraps the Tauri `auth_status` /
 * `auth_login` / `auth_logout` commands (`@/lib/desktop/tauri-bridge`)
 * behind one hook so `index.native.tsx`, `use-desktop-auth-form-defaults.ts`
 * (the shared form's desktop actions), and `use-native-session-sync.ts`
 * share a single source of truth instead of each polling `auth_status`
 * themselves.
 *
 * This module is reachable from the SHARED shell (`AuthEntry`, the `/login`
 * route), which is compiled into both the web and desktop bundles — so the
 * bridge is loaded through `loadBridge()` below rather than a static import.
 * The underlying query is gated on `isDesktopAppEnvironment()`, so a normal
 * browser tab never fires the Tauri IPC call.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import type { AuthStatus } from "@/lib/desktop/tauri-bridge";
import { isDesktopAppEnvironment } from "@/hooks/use-is-desktop-app";

type DesktopBridge = typeof import("@/lib/desktop/tauri-bridge");

/**
 * Lazy, build-flag-guarded access to the Tauri bridge. The literal
 * `import.meta.env.VITE_TAURI_APP` check (the same single knob
 * `isDesktopAppEnvironment()` reads — see its "one knob" doc) must sit
 * DIRECTLY at the dynamic-import site: Rollup decides chunk emission per
 * module, so only a statically-false branch here keeps the bridge chunk out
 * of the browser bundle entirely. A static import — or a dynamic one behind
 * the helper function, which Rollup cannot inline — would ship Tauri IPC
 * code to every browser visitor and trip the
 * `scripts/check-web-bundle-desktop-free.ts` CI guard, which scans every
 * emitted asset.
 */
async function loadBridge(): Promise<DesktopBridge> {
  if (import.meta.env.VITE_TAURI_APP !== "1") {
    throw new Error("Tauri bridge is unavailable outside the desktop build");
  }
  return import("@/lib/desktop/tauri-bridge");
}

export interface DesktopAuth {
  status: AuthStatus | undefined;
  /** True while the INITIAL `auth_status` check is in flight. */
  isChecking: boolean;
  /** True while a user-requested Keychain status retry is in flight. */
  isRetryingStatus: boolean;
  /** True while `auth_login`/`auth_logout` itself is in flight (the system
   *  browser is open / the Keychain is being cleared). */
  isPending: boolean;
  loginError: string | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  /** True while `completeSession` (the hybrid-login bridge) is in flight —
   *  a brief, invisible-to-the-user server-side round trip, distinct from
   *  `isPending`'s "system browser is open" wait. */
  isCompletingSession: boolean;
  completeSessionError: string | null;
  /**
   * Finalizes a Better-Auth cookie session established through the shared
   * auth form's email/password or email-OTP submit (proxied through
   * local-api's bare `/api/auth/*`, cookie captured server-side) into
   * the Keychain via `auth_complete_session`, then re-checks `auth_status`.
   * Wired as the shared form's `onAuthenticated` action for desktop — see
   * `auth-actions.ts` / `use-desktop-auth-form-defaults.ts`.
   */
  completeSession: () => Promise<void>;
  /** Re-runs `auth_status` after a transient Keychain access failure. */
  retryStatus: () => Promise<void>;
}

export function useDesktopAuth(): DesktopAuth {
  const queryClient = useQueryClient();
  const isDesktopApp = isDesktopAppEnvironment();
  const statusQuery = useQuery({
    queryKey: KEYS.desktopAuthStatus(),
    queryFn: async () => (await loadBridge()).fetchAuthStatus(),
    // Outside the Tauri webview (the shared `/login` route's web build)
    // `loadBridge` would only throw — never fetch, never enable.
    enabled: isDesktopApp,
    staleTime: 30_000,
    // A stale/expired upstream session should self-heal by re-checking on
    // refocus rather than staying stuck on a cached "signed in" forever.
    refetchOnWindowFocus: true,
  });
  const [isPending, setPending] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isCompletingSession, setCompletingSession] = useState(false);
  const [completeSessionError, setCompleteSessionError] = useState<
    string | null
  >(null);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- Tauri event subscription lifecycle
  useEffect(() => {
    if (!isDesktopApp) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void loadBridge()
      .then((bridge) =>
        bridge.listenForAuthStatus((status) => {
          queryClient.setQueryData(KEYS.desktopAuthStatus(), status);
        }),
      )
      .then((stopListening) => {
        if (disposed) {
          stopListening();
        } else {
          unlisten = stopListening;
        }
      })
      .catch((error: unknown) => {
        console.error("Could not subscribe to native auth status", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isDesktopApp, queryClient]);

  async function login(): Promise<void> {
    setPending(true);
    setLoginError(null);
    try {
      const bridge = await loadBridge();
      await bridge.performAuthLogin();
      const status = await bridge.fetchAuthStatus();
      queryClient.setQueryData(KEYS.desktopAuthStatus(), status);
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setPending(false);
    }
  }

  async function logout(): Promise<void> {
    setPending(true);
    try {
      const bridge = await loadBridge();
      await bridge.performAuthLogout();
      const status = await bridge.fetchAuthStatus();
      queryClient.setQueryData(KEYS.desktopAuthStatus(), status);
    } finally {
      setPending(false);
    }
  }

  async function completeSession(): Promise<void> {
    setCompletingSession(true);
    setCompleteSessionError(null);
    let bridge: DesktopBridge;
    try {
      bridge = await loadBridge();
    } catch (err) {
      setCompleteSessionError(
        err instanceof Error ? err.message : "Sign-in failed",
      );
      setCompletingSession(false);
      return;
    }
    try {
      await bridge.performAuthCompleteSession();
    } catch (err) {
      // Bridging failed (e.g. the mesh authorize call itself errored) — the
      // Better-Auth cookie session may still be sitting in local-api's jar,
      // but there's nothing more this call can do about it; surface the
      // error and let the user retry the submit. `auth_status` is still
      // re-checked below regardless, since a partial bridge could plausibly
      // have still signed the Keychain in.
      setCompleteSessionError(
        err instanceof Error ? err.message : "Sign-in failed",
      );
    } finally {
      try {
        const status = await bridge.fetchAuthStatus();
        queryClient.setQueryData(KEYS.desktopAuthStatus(), status);
      } finally {
        setCompletingSession(false);
      }
    }
  }

  async function retryStatus(): Promise<void> {
    await statusQuery.refetch();
  }

  return {
    status: statusQuery.data,
    isChecking: statusQuery.isLoading,
    isRetryingStatus: statusQuery.isFetching,
    isPending,
    loginError,
    login,
    logout,
    isCompletingSession,
    completeSessionError,
    completeSession,
    retryStatus,
  };
}
