/**
 * Desktop's overrides for the shared sign-in surface's injectable actions
 * (`apps/web/src/components/auth-form-actions.ts`), plus the one bit of
 * config-driven UI-mode logic the desktop sign-in screen needs
 * (`needsBrowserOnlyFallback`). Pure — no Tauri IPC happens in this file
 * itself; the actual `auth_login()`/`auth_complete_session()` calls are
 * injected as `deps` (see `use-desktop-auth.ts`), which is what keeps this
 * module unit-testable per TESTING.md ("if a test needs mock.module … it's
 * not a unit test").
 */
import type { AuthFormActions } from "@/components/auth-form-actions";

export interface DesktopAuthActionDeps {
  /**
   * `DesktopAuth.login` — opens the system browser for the existing
   * `auth_login()` OAuth/SAML PKCE flow. Used for every "leaves the app"
   * method: social provider buttons, the deployment-wide forced-SSO
   * auto-redirect, and the magic-link-only fallback screen
   * (`needsBrowserOnlyFallback` below). `auth_login()` always drives the
   * SAME flow regardless of which button triggered it — the system browser
   * renders the real web `/login` page, where the user picks (or is forced
   * into) whichever method actually applies; the in-app button is an
   * affordance, not a provider selector, so the `provider`/`providerId`
   * arguments are intentionally ignored here.
   */
  browserSignIn: () => Promise<void>;
  /**
   * `DesktopAuth.completeSession` — bridges the Better-Auth cookie session a
   * successful email/password or email-OTP submit just established
   * (captured server-side into local-api's in-memory cookie jar by the
   * the bare `/api/auth/*` proxy) into the Keychain via
   * `auth_complete_session`, then re-checks `auth_status`.
   */
  completeBridgedSignIn: () => Promise<void>;
}

/**
 * Only THREE of the six `AuthFormActions` slots are overridden:
 *
 *  - `socialSignIn` / `ssoSignIn` -> the system-browser hop. Never call
 *    `authClient.signIn.social`/`signIn.sso` in-webview: those navigate the
 *    CURRENT window to Google/the SAML IdP, which can't complete a loopback
 *    redirect back into a Tauri window.
 *  - `onAuthenticated` -> the Keychain bridge, instead of a
 *    `window.location` navigate (there's nowhere useful to navigate the
 *    webview to — the session cookie the navigate would rely on was never
 *    handed to it in the first place).
 *
 * `submitEmailPassword`, `requestPasswordReset`, `sendOtp`, and `submitOtp`
 * are left at their defaults (`defaultAuthFormActions`, i.e. plain
 * `authClient` calls) on purpose: the native page and local-api are
 * same-origin, authenticated by the HttpOnly local session established before
 * React mounts. No bespoke fetch plumbing is needed for those four — the
 * network layer is identical to the web app's, and error bodies pass through
 * verbatim so the shared form's
 * existing error-message mapping (`getErrorMessage` in
 * `unified-auth-form.tsx`) keeps working unchanged.
 */
export function createDesktopAuthActions(
  deps: DesktopAuthActionDeps,
): Partial<AuthFormActions> {
  const browserHop = async () => {
    await deps.browserSignIn();
    return {};
  };
  return {
    socialSignIn: browserHop,
    ssoSignIn: browserHop,
    onAuthenticated: async () => {
      await deps.completeBridgedSignIn();
    },
  };
}

/** The subset of `AuthConfig` (`apps/api/src/api/routes/auth.ts`) the
 *  fallback decision below reads. Declared locally instead of importing the
 *  full type so this module (and its unit test) stays decoupled from the
 *  server route file's other, irrelevant fields. */
export interface DesktopAuthMethodConfig {
  emailAndPassword: { enabled: boolean };
  emailOtp: { enabled: boolean };
  socialProviders: { enabled: boolean };
  magicLink: { enabled: boolean };
  sso: { enabled: boolean };
}

/**
 * True when none of the shared form's in-app methods (password, OTP,
 * social) are configured and the only enabled method is magic link — the
 * one auth method with genuinely no in-app UI. `UnifiedAuthForm` has no
 * magic-link view even on web: clicking a magic-link email opens a browser
 * tab, which can't hand a session back to a Tauri webview the way an
 * in-webview OTP/password submit can. When this is true, the desktop
 * sign-in screen skips the shared form entirely and shows a single
 * "continue in your browser" affordance instead (reusing the same
 * `auth_login()` browser hop as social/SSO) — see `sign-in-screen.tsx`.
 *
 * `sso.enabled` is excluded from the "in-app method" check on purpose: it
 * already gets its own auto-redirect branch inside `AuthEntry` (`RunSSO`)
 * regardless of this function's result, so a deployment with SSO forced on
 * never reaches this fallback at all.
 */
export function needsBrowserOnlyFallback(
  config: DesktopAuthMethodConfig,
): boolean {
  const hasInAppMethod =
    config.emailAndPassword.enabled ||
    config.emailOtp.enabled ||
    config.socialProviders.enabled;
  return !hasInAppMethod && !config.sso.enabled && config.magicLink.enabled;
}
