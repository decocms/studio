import { useEffect, useEffectEvent, useState } from "react";
import type { ReactNode } from "react";
import { retry, RetryError } from "@decocms/shared/std";
import { SplashScreen } from "@/components/splash-screen";
import { UnifiedAuthForm } from "@/components/unified-auth-form";
import type {
  AuthFlowEvent,
  UnifiedAuthFormCopy,
} from "@/components/unified-auth-form";
import {
  defaultAuthFormActions,
  type AuthFormActions,
} from "@/components/auth-form-actions";
import { useDesktopAuthFormDefaults } from "@/desktop/use-desktop-auth-form-defaults";
import { needsBrowserOnlyFallback } from "@/desktop/auth-actions";
import { BrowserOnlyColumn } from "@/desktop/browser-only-column";
import { StatusColumn } from "@/desktop/status-column";
import { useAuthConfig } from "@/providers/auth-config-provider";
import { useT } from "@/i18n/use-t.ts";

export interface AuthEntryProps {
  callbackUrl: string;
  redirectUrl?: string | null;
  allowAutoLogin?: boolean;
  /** Title for the default view of the email/social auth form. */
  title?: string;
  /** Subtitle for the default view; `null` hides it. */
  subtitle?: string | null;
  /** Brand element rendered above the auth form header. */
  brand?: ReactNode;
  /** Optional localized copy for the auth form. */
  copy?: Partial<UnifiedAuthFormCopy>;
  /** Compact layout for embedded auth surfaces. */
  variant?: "default" | "compact";
  /** Limit social buttons without changing the global login page. */
  allowedSocialProviders?: string[];
  /** Hide password auth in OTP-first embedded surfaces. */
  allowPassword?: boolean;
  /** Optional lifecycle sink for embedded surfaces with their own funnel. */
  onAuthEvent?: (event: AuthFlowEvent) => void;
  /** Override the default post-auth navigation for embedded surfaces that
   *  want to unlock already-mounted content in place (e.g. refetching a
   *  query) instead of navigating away. Ignored on desktop, where the
   *  Keychain-bridge `onAuthenticated` always takes precedence — see
   *  `resolvedActions` below. */
  onAuthenticated?: AuthFormActions["onAuthenticated"];
}

class RetriableAutoLoginResponse {
  constructor(readonly response: Response) {}
}

function safeRelativeRedirect(redirectTo: string): string {
  return redirectTo.startsWith("/") && !redirectTo.startsWith("//")
    ? redirectTo
    : "/";
}

/**
 * Auto-login for local mode.
 * Calls the local-session endpoint and reloads to pick up the session cookie.
 */
function AutoLogin({
  redirectTo,
  onAuthEvent,
}: {
  redirectTo: string;
  onAuthEvent?: (event: AuthFlowEvent) => void;
}) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const emitAuthEvent = useEffectEvent((event: AuthFlowEvent) => {
    try {
      onAuthEvent?.(event);
    } catch {
      // An analytics sink must never interrupt authentication.
    }
  });

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    let cancelled = false;

    (async () => {
      emitAuthEvent({ type: "started", method: "local" });
      try {
        let res: Response;
        try {
          res = await retry(
            async () => {
              const response = await fetch("/api/auth/custom/local-session", {
                method: "POST",
                credentials: "include",
              });
              if (response.status >= 500) {
                throw new RetriableAutoLoginResponse(response);
              }
              return response;
            },
            {
              maxAttempts: 5,
              minTimeout: 1000,
              maxTimeout: 10000,
              multiplier: 2,
              jitter: 0,
            },
          );
        } catch (err) {
          if (
            err instanceof RetryError &&
            err.cause instanceof RetriableAutoLoginResponse
          ) {
            res = err.cause.response;
          } else {
            throw err;
          }
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || t("common.authEntry.autoLoginFailed"));
        }
        if (!cancelled) {
          emitAuthEvent({ type: "succeeded", method: "local" });
          window.location.href = safeRelativeRedirect(redirectTo);
        }
      } catch (err) {
        if (!cancelled) {
          emitAuthEvent({
            type: "failed",
            method: "local",
            stage: "authenticate",
            error: err instanceof Error ? err.message : String(err),
          });
          setError(
            err instanceof Error
              ? err.message
              : t("common.authEntry.autoLoginFailed"),
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [redirectTo]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <p className="text-destructive mb-2">
            {t("common.authEntry.autoLoginFailedWithError", { error })}
          </p>
          <p className="text-muted-foreground text-sm">
            {t("common.authEntry.tryRestartingServer")}
          </p>
        </div>
      </div>
    );
  }

  return <SplashScreen />;
}

function RunSSO({
  callbackURL,
  providerId,
  ssoSignIn,
  onAuthEvent,
}: {
  providerId: string;
  callbackURL: string;
  ssoSignIn: AuthFormActions["ssoSignIn"];
  onAuthEvent?: (event: AuthFlowEvent) => void;
}) {
  const emitAuthEvent = useEffectEvent((event: AuthFlowEvent) => {
    try {
      onAuthEvent?.(event);
    } catch {
      // An analytics sink must never interrupt authentication.
    }
  });
  // Reads the latest `ssoSignIn` reference without needing it in the effect's
  // deps array (same reasoning as `emitAuthEvent` above) — desktop's caller
  // recomputes its action object every render.
  const runSsoSignIn = useEffectEvent(ssoSignIn);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    (async () => {
      emitAuthEvent({
        type: "started",
        method: "sso",
        provider: providerId,
      });
      try {
        const result = await runSsoSignIn({
          providerId,
          callbackURL,
        });
        if (result.error) {
          throw new Error(result.error.message || "SSO redirect failed");
        }
      } catch (error) {
        emitAuthEvent({
          type: "failed",
          method: "sso",
          provider: providerId,
          stage: "redirect",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, [providerId, callbackURL]);

  return <SplashScreen />;
}

export function AuthEntry({
  callbackUrl,
  redirectUrl,
  allowAutoLogin = true,
  title,
  subtitle,
  brand,
  copy,
  variant,
  allowedSocialProviders,
  allowPassword,
  onAuthEvent,
  onAuthenticated,
}: AuthEntryProps) {
  const t = useT();
  const {
    sso,
    emailAndPassword,
    magicLink,
    emailOtp,
    socialProviders,
    localMode,
  } = useAuthConfig();
  const desktopDefaults = useDesktopAuthFormDefaults();
  const redirectAfterLogin = redirectUrl || callbackUrl;
  // Actions are resolved per platform HERE, beneath every sign-in surface
  // (the web/shell `/login` route, the desktop gate, embedded surfaces):
  // web defaults, with the desktop browser-hop/Keychain-bridge overrides
  // layered on top in the desktop build. No call site wires this itself —
  // that's what makes the "forgot the desktop override, social buttons
  // silently dead-end in Tauri" bug class unrepresentable. The one exception
  // is `onAuthenticated`: an embedded surface may know how to unlock its own
  // already-mounted content (e.g. refetch a query) instead of navigating —
  // applied between the web default and the platform override, so desktop's
  // Keychain bridge still always wins.
  const callerOverrides = onAuthenticated ? { onAuthenticated } : undefined;
  const platformOverrides = desktopDefaults?.actions;
  const resolvedActions: AuthFormActions = {
    ...defaultAuthFormActions,
    ...callerOverrides,
    ...platformOverrides,
  };

  // The system-browser hop / Keychain bridge is a full takeover: nothing in
  // the shared form is usable while either is in flight. Placed above every
  // branch: these states can only be in flight after one of the desktop
  // actions actually ran.
  if (desktopDefaults?.isPending) {
    return (
      <StatusColumn
        label={t("common.authEntry.finishSignInInBrowser")}
        error={desktopDefaults.loginError}
      />
    );
  }
  if (desktopDefaults?.isCompletingSession) {
    return (
      <StatusColumn
        label={t("common.authEntry.finishingSignIn")}
        error={desktopDefaults.completeSessionError}
      />
    );
  }

  if (localMode && allowAutoLogin) {
    return (
      <AutoLogin redirectTo={redirectAfterLogin} onAuthEvent={onAuthEvent} />
    );
  }

  if (sso.enabled) {
    return (
      <RunSSO
        callbackURL={redirectAfterLogin}
        providerId={sso.providerId}
        ssoSignIn={resolvedActions.ssoSignIn}
        onAuthEvent={onAuthEvent}
      />
    );
  }

  // Desktop only: a magic-link-ONLY deployment has no in-app UI to fall
  // back to at all (magic links open in the system browser and can't hand a
  // session back to the webview), so skip the shared form and show a single
  // browser-hop affordance instead — see `needsBrowserOnlyFallback`.
  if (
    desktopDefaults &&
    needsBrowserOnlyFallback({
      emailAndPassword,
      emailOtp,
      socialProviders,
      magicLink,
      sso,
    })
  ) {
    return (
      <BrowserOnlyColumn
        onContinue={desktopDefaults.login}
        isPending={desktopDefaults.isPending}
        error={desktopDefaults.loginError}
      />
    );
  }

  if (
    emailAndPassword.enabled ||
    magicLink.enabled ||
    emailOtp.enabled ||
    socialProviders.enabled
  ) {
    // A settled browser-hop/bridge failure: `auth_login` errors land in the
    // desktop defaults' hook state, not in any of `UnifiedAuthForm`'s
    // mutations, so its own banner never sees them — surface here, same
    // visual treatment. (Null on web.)
    const desktopError =
      desktopDefaults?.loginError ??
      desktopDefaults?.completeSessionError ??
      null;
    const form = (
      <UnifiedAuthForm
        redirectUrl={redirectUrl}
        callbackUrl={callbackUrl}
        title={title}
        subtitle={subtitle}
        brand={brand}
        copy={copy}
        variant={variant}
        allowedSocialProviders={allowedSocialProviders}
        allowPassword={allowPassword}
        onAuthEvent={onAuthEvent}
        actions={{ ...callerOverrides, ...platformOverrides }}
      />
    );
    if (!desktopError) return form;
    return (
      <div className="grid gap-4">
        <div className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive text-center">
          {desktopError}
        </div>
        {form}
      </div>
    );
  }

  return <div>{t("common.authEntry.noLoginOptions")}</div>;
}
