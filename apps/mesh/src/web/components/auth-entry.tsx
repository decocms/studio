import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { retry, RetryError } from "@decocms/std";
import { SplashScreen } from "@/web/components/splash-screen";
import { UnifiedAuthForm } from "@/web/components/unified-auth-form";
import type { UnifiedAuthFormCopy } from "@/web/components/unified-auth-form";
import { authClient } from "@/web/lib/auth-client";
import { useAuthConfig } from "@/web/providers/auth-config-provider";

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
function AutoLogin({ redirectTo }: { redirectTo: string }) {
  const [error, setError] = useState<string | null>(null);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    let cancelled = false;

    (async () => {
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
          throw new Error(data?.error || "Auto-login failed");
        }
        if (!cancelled) {
          window.location.href = safeRelativeRedirect(redirectTo);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Auto-login failed");
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
          <p className="text-destructive mb-2">Auto-login failed: {error}</p>
          <p className="text-muted-foreground text-sm">
            Try restarting the server.
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
}: {
  providerId: string;
  callbackURL: string;
}) {
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    (async () => {
      await authClient.signIn.sso({
        providerId,
        callbackURL,
      });
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
}: AuthEntryProps) {
  const {
    sso,
    emailAndPassword,
    magicLink,
    emailOtp,
    socialProviders,
    localMode,
  } = useAuthConfig();
  const redirectAfterLogin = redirectUrl || callbackUrl;

  if (localMode && allowAutoLogin) {
    return <AutoLogin redirectTo={redirectAfterLogin} />;
  }

  if (sso.enabled) {
    return (
      <RunSSO callbackURL={redirectAfterLogin} providerId={sso.providerId} />
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
      />
    );
  }

  return <div>No login options available</div>;
}
