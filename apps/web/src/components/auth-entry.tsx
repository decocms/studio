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
  /**
   * Overrides for the underlying network/post-auth actions (forwarded to
   * `UnifiedAuthForm` and used for the `sso.enabled` auto-redirect branch
   * below). Omitted -> `defaultAuthFormActions`. See
   * `apps/web/src/components/auth-form-actions.ts`.
   */
  actions?: Partial<AuthFormActions>;
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
  actions,
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
  const redirectAfterLogin = redirectUrl || callbackUrl;
  const resolvedActions: AuthFormActions = {
    ...defaultAuthFormActions,
    ...actions,
  };

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

  if (
    emailAndPassword.enabled ||
    magicLink.enabled ||
    emailOtp.enabled ||
    socialProviders.enabled
  ) {
    return (
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
        actions={actions}
      />
    );
  }

  return <div>{t("common.authEntry.noLoginOptions")}</div>;
}
