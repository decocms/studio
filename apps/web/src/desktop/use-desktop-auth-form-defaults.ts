/**
 * Platform-aware DEFAULTS for the shared sign-in surface's injectable
 * actions. `AuthEntry` calls this unconditionally; on the web build it
 * returns `null` and the surface behaves exactly as before. On the desktop
 * build it supplies `createDesktopAuthActions` (system-browser hop for
 * social/SSO, Keychain bridge for `onAuthenticated`) plus the hop's
 * pending/error state so `AuthEntry` can render them.
 *
 * WHY this exists: the original login wedge was a call site
 * (`routes/login.tsx`) rendering the shared form WITHOUT the desktop
 * `actions` override — a silently-valid omission whose Google/GitHub buttons
 * dead-end inside Tauri (external navigation is blocked by
 * `setup.rs::is_allowed_webview_navigation`). Resolving the desktop defaults
 * HERE, beneath every call site, makes that class of bug unrepresentable:
 * every sign-in surface — the shared `/login` route, the desktop gate
 * (`sign-in-screen.tsx`), the embedded auth surfaces — gets correct behavior
 * on both platforms without wiring anything itself.
 */
import { isDesktopAppEnvironment } from "@/hooks/use-is-desktop-app";
import { useDesktopAuth } from "@/desktop/use-desktop-auth";
import { createDesktopAuthActions } from "@/desktop/auth-actions";
import type { AuthFormActions } from "@/components/auth-form-actions";

export interface DesktopAuthFormDefaults {
  actions: Partial<AuthFormActions>;
  /** The raw system-browser hop, for form-less affordances (the magic-link-
   *  only fallback's "Continue in your browser" button). */
  login: () => Promise<void>;
  /** True while the system-browser hop (`auth_login`) is in flight. */
  isPending: boolean;
  loginError: string | null;
  /** True while the Keychain bridge (`auth_complete_session`) is in flight. */
  isCompletingSession: boolean;
  completeSessionError: string | null;
}

export function useDesktopAuthFormDefaults(): DesktopAuthFormDefaults | null {
  // Unconditional hook call; inert on web (query disabled, listener gated).
  const auth = useDesktopAuth();
  if (!isDesktopAppEnvironment()) return null;
  return {
    actions: createDesktopAuthActions({
      browserSignIn: auth.login,
      completeBridgedSignIn: auth.completeSession,
    }),
    login: auth.login,
    isPending: auth.isPending,
    loginError: auth.loginError,
    isCompletingSession: auth.isCompletingSession,
    completeSessionError: auth.completeSessionError,
  };
}
