/**
 * Sign-in gate shown when `auth_status()` says signed out. Hybrid design
 * (post-v1 owner feedback): reuses the SAME shared components the web
 * `/login` route renders (`AuthSplitLayout` + `AuthEntry` +
 * `UnifiedAuthForm`) — never a visual fork — wired with desktop-specific
 * actions instead of a bespoke UI:
 *
 *  - Email/password and email-OTP submit through local-api's
 *    bare `/api/auth/*` proxy exactly like the web app's own calls do
 *    (same-origin after `index.native.tsx` establishes its local session); on success, the
 *    Better-Auth session cookie the proxy captured server-side is bridged
 *    into the Keychain via `auth_complete_session` (`useDesktopAuth`'s
 *    `completeSession`, wired as `onAuthenticated` — see `auth-actions.ts`).
 *  - Google/GitHub/SAML buttons, and the deployment-wide forced-SSO
 *    auto-redirect, invoke the existing `auth_login()` system-browser PKCE
 *    flow instead (`socialSignIn`/`ssoSignIn` overrides) — see
 *    `auth-actions.ts`'s module doc for why the button clicked doesn't
 *    matter.
 *  - A magic-link-ONLY deployment (no password/OTP/social configured) has
 *    no in-app UI to fall back to at all (magic links open in the system
 *    browser and can't hand a session back to the webview), so it skips the
 *    shared form entirely and shows the same browser-hop affordance —
 *    `needsBrowserOnlyFallback` in `auth-actions.ts`.
 *
 * This screen has NO org-choice/org-picker UI of its own: after sign-in
 * (either path) the app just hands off to the real production shell
 * (`apps/web/src`), whose own `organization.list` call, last-visited-
 * org logic, and org-creation flow cover org selection identically to the
 * web app — see the native authentication contract.
 *
 * Auth-config awareness (which methods are enabled) comes from the SAME
 * source the web app uses — `usePublicConfig()`/`AuthConfigProvider`,
 * fetching relative `/api/config` from local-api the same way every other
 * `/api/...` call does. `GET /api/config` is
 * public/no-auth on mesh, and local-api's app-API proxy gives it the
 * same bearer-free treatment as `/api/auth/*`
 * (`routes/upstream.rs`'s `PUBLIC_NO_AUTH_PATH`/`proxy_public_config`) so
 * this fetch succeeds even at the pre-sign-in moment this screen needs it
 * most (no Keychain session yet). The `ErrorBoundary` below stays as a
 * belt-and-suspenders "couldn't load, try again" state for a genuine
 * network failure, not a known-broken first paint.
 *
 * Layout: `AuthSplitLayout` is hoisted ONCE at the top of `SignInScreen` and
 * every state below only supplies its inner column content — see
 * the native authentication-success contract §5.2. This keeps the
 * right-hand visual panel and the left column's max-width frame mounted and
 * stable across every transition (sign-in form -> social/SSO browser-hop ->
 * back -> Keychain bridge -> real app), instead of popping in and out on
 * each state change.
 */
import { Suspense } from "react";
import { AuthEntry } from "@/components/auth-entry";
import { AuthSplitLayout } from "@/components/auth-split-layout";
import { ErrorBoundary } from "@/components/error-boundary";
import {
  AuthConfigProvider,
  useAuthConfig,
} from "@/providers/auth-config-provider";
import { Button } from "@deco/ui/components/button.tsx";
import { StatusColumn } from "@/desktop/status-column";
import type { DesktopAuth } from "@/desktop/use-desktop-auth";
import {
  createDesktopAuthActions,
  needsBrowserOnlyFallback,
} from "@/desktop/auth-actions";

/** The "couldn't load sign-in options" retry column — `ErrorBoundary`'s
 *  fallback, trimmed to just the column's inner content (no full-screen
 *  wrapper — `AuthSplitLayout`'s own `<section>` already provides that). */
function ConfigErrorColumn({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <p className="max-w-sm text-sm text-muted-foreground">
        Couldn't load sign-in options.
      </p>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** The magic-link-only fallback: no in-app form, just a single button that
 *  reuses the same `auth_login()` browser hop as social/SSO. See this
 *  module's doc comment and `auth-actions.ts::needsBrowserOnlyFallback`. */
function BrowserOnlyColumn({ auth }: { auth: DesktopAuth }) {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-medium text-foreground">Welcome to deco</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          This organization signs in with an emailed link, which can't be opened
          inside the app. Continue in your browser to finish signing in.
        </p>
      </div>
      <Button onClick={() => void auth.login()} disabled={auth.isPending}>
        Continue in your browser
      </Button>
      {auth.loginError && (
        <p className="max-w-sm text-xs text-destructive">{auth.loginError}</p>
      )}
    </div>
  );
}

function SignInFormOrBrowserOnly({ auth }: { auth: DesktopAuth }) {
  const config = useAuthConfig();

  if (needsBrowserOnlyFallback(config)) {
    return <BrowserOnlyColumn auth={auth} />;
  }

  const actions = createDesktopAuthActions({
    browserSignIn: auth.login,
    completeBridgedSignIn: auth.completeSession,
  });

  return (
    <div className="grid gap-4">
      {auth.completeSessionError && (
        // Bridging (auth_complete_session) runs AFTER the shared form's
        // own mutation already succeeded, so `UnifiedAuthForm`'s internal
        // error banner (tied to that mutation's state) never sees this
        // failure — surface it here instead, same visual treatment.
        <div className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive text-center">
          {auth.completeSessionError}
        </div>
      )}
      <AuthEntry
        callbackUrl="/"
        // Local-mode auto-login (`AuthEntry`'s `localMode` branch) sets a
        // session cookie directly via `/api/auth/custom/local-session` —
        // it isn't part of the hybrid-login bridge contract (email/
        // password, OTP, browser-hop social/SSO only), so it's disabled
        // here rather than left to silently bypass the Keychain bridge.
        allowAutoLogin={false}
        // No title/subtitle overrides: the shared form's own defaults
        // ("Welcome to deco" / "Sign in or create a new account") keep this
        // screen's copy identical to the web /login page by construction.
        actions={actions}
      />
    </div>
  );
}

function renderState(auth: DesktopAuth) {
  // The system-browser hop (social/SSO/browser-only-fallback) is a full
  // takeover: nothing in the shared form is usable while it's in flight.
  if (auth.isPending) {
    return (
      <StatusColumn
        label="Finish signing in in your browser…"
        error={auth.loginError}
      />
    );
  }

  // The Keychain bridge (email/password or OTP success) is a brief,
  // invisible-to-the-browser round trip — distinct copy from the above.
  if (auth.isCompletingSession) {
    return (
      <StatusColumn
        label="Finishing sign-in…"
        error={auth.completeSessionError}
      />
    );
  }

  return (
    <ErrorBoundary
      fallback={({ resetError }) => <ConfigErrorColumn onRetry={resetError} />}
    >
      <Suspense fallback={<StatusColumn />}>
        <AuthConfigProvider>
          <SignInFormOrBrowserOnly auth={auth} />
        </AuthConfigProvider>
      </Suspense>
    </ErrorBoundary>
  );
}

export function SignInScreen({ auth }: { auth: DesktopAuth }) {
  return <AuthSplitLayout>{renderState(auth)}</AuthSplitLayout>;
}
