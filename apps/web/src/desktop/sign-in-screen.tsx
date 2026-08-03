/**
 * Sign-in gate shown when `auth_status()` says signed out. Hybrid design
 * (post-v1 owner feedback): renders the SAME shared surface the web `/login`
 * route renders (`AuthSplitLayout` + `AuthEntry` + `UnifiedAuthForm`) —
 * never a visual fork. All desktop-specific behavior now lives INSIDE
 * `AuthEntry` (via `useDesktopAuthFormDefaults`): the system-browser hop for
 * social/SSO, the Keychain bridge for email/password + OTP, the browser-hop
 * pending/error states, and the magic-link-only fallback. This screen only
 * supplies what `AuthEntry` cannot know: the split layout, the auth-config
 * fetch boundary, and disabling local-mode auto-login (which would bypass
 * the Keychain bridge contract).
 *
 * This screen has NO org-choice/org-picker UI of its own: after sign-in the
 * app just hands off to the real production shell (`apps/web/src`), whose
 * own `organization.list` call, last-visited-org logic, and org-creation
 * flow cover org selection identically to the web app — see the native
 * authentication contract.
 *
 * Auth-config awareness (which methods are enabled) comes from the SAME
 * source the web app uses — `usePublicConfig()`/`AuthConfigProvider`,
 * fetching relative `/api/config` from local-api the same way every other
 * `/api/...` call does. `GET /api/config` is public/no-auth on mesh, and
 * local-api's app-API proxy gives it the same bearer-free treatment as
 * `/api/auth/*` (`routes/upstream.rs`'s
 * `PUBLIC_NO_AUTH_PATH`/`proxy_public_config`) so this fetch succeeds even
 * at the pre-sign-in moment this screen needs it most (no Keychain session
 * yet). The `ErrorBoundary` below stays as a belt-and-suspenders "couldn't
 * load, try again" state for a genuine network failure, not a known-broken
 * first paint.
 *
 * Layout: `AuthSplitLayout` is hoisted ONCE at the top and every state
 * (config loading, sign-in form, browser-hop takeover, Keychain bridge)
 * only supplies inner column content — see the native
 * authentication-success contract §5.2. This keeps the right-hand visual
 * panel and the left column's max-width frame mounted and stable across
 * every transition instead of popping in and out on each state change.
 */
import { Suspense } from "react";
import { AuthEntry } from "@/components/auth-entry";
import { AuthSplitLayout } from "@/components/auth-split-layout";
import { ErrorBoundary } from "@/components/error-boundary";
import { AuthConfigProvider } from "@/providers/auth-config-provider";
import { Button } from "@deco/ui/components/button.tsx";
import { StatusColumn } from "@/desktop/status-column";
import { useT } from "@/i18n/use-t.ts";

/** The "couldn't load sign-in options" retry column — `ErrorBoundary`'s
 *  fallback, trimmed to just the column's inner content (no full-screen
 *  wrapper — `AuthSplitLayout`'s own `<section>` already provides that). */
function ConfigErrorColumn({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <p className="max-w-sm text-sm text-muted-foreground">
        {t("common.signInScreen.configLoadFailed")}
      </p>
      <Button variant="outline" onClick={onRetry}>
        {t("common.signInScreen.tryAgain")}
      </Button>
    </div>
  );
}

export function SignInScreen() {
  return (
    <AuthSplitLayout>
      <ErrorBoundary
        fallback={({ resetError }) => (
          <ConfigErrorColumn onRetry={resetError} />
        )}
      >
        <Suspense fallback={<StatusColumn />}>
          <AuthConfigProvider>
            <AuthEntry
              callbackUrl="/"
              // Local-mode auto-login (`AuthEntry`'s `localMode` branch)
              // sets a session cookie directly via
              // `/api/auth/custom/local-session` — it isn't part of the
              // hybrid-login bridge contract (email/password, OTP,
              // browser-hop social/SSO only), so it's disabled here rather
              // than left to silently bypass the Keychain bridge.
              allowAutoLogin={false}
            />
          </AuthConfigProvider>
        </Suspense>
      </ErrorBoundary>
    </AuthSplitLayout>
  );
}
