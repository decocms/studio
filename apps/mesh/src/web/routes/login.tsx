import { useEffect, useState } from "react";
import { useAuthConfig } from "@/web/providers/auth-config-provider";
import { SplashScreen } from "@/web/components/splash-screen";
import { authClient } from "@/web/lib/auth-client";
import { Navigate, useSearch } from "@tanstack/react-router";
import { UnifiedAuthForm } from "@/web/components/unified-auth-form";

/**
 * Build the OAuth authorize URL from search params
 * This is used to redirect back to the MCP authorize endpoint after login
 */
function buildOAuthAuthorizeUrl(params: {
  client_id?: string;
  redirect_uri?: string;
  response_type?: string;
  state?: string;
  scope?: string;
  code_challenge?: string;
  code_challenge_method?: string;
}): string | null {
  // Check if this is an OAuth flow (requires client_id and response_type=code)
  if (!params.client_id || params.response_type !== "code") {
    return null;
  }

  const searchParams = new URLSearchParams();
  if (params.client_id) searchParams.set("client_id", params.client_id);
  if (params.redirect_uri)
    searchParams.set("redirect_uri", params.redirect_uri);
  if (params.response_type)
    searchParams.set("response_type", params.response_type);
  if (params.state) searchParams.set("state", params.state);
  if (params.scope) searchParams.set("scope", params.scope);
  if (params.code_challenge)
    searchParams.set("code_challenge", params.code_challenge);
  if (params.code_challenge_method)
    searchParams.set("code_challenge_method", params.code_challenge_method);

  return `/api/auth/mcp/authorize?${searchParams.toString()}`;
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

/**
 * Auto-login for local mode.
 * Calls the local-session endpoint and refreshes the page.
 */
function AutoLogin({ redirectTo }: { redirectTo: string }) {
  const [error, setError] = useState<string | null>(null);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/auth/custom/local-session", {
          method: "POST",
          credentials: "include",
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Auto-login failed");
        }
        if (!cancelled) {
          // Validate redirectTo to prevent open redirects.
          // Only allow relative paths that start with "/" but not "//".
          const safeRedirect =
            redirectTo.startsWith("/") && !redirectTo.startsWith("//")
              ? redirectTo
              : "/";
          // Reload to pick up the new session cookie
          window.location.href = safeRedirect;
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
            Try restarting the mesh server.
          </p>
        </div>
      </div>
    );
  }

  return <SplashScreen />;
}

export default function LoginRoute() {
  const session = authClient.useSession();
  const searchParams = useSearch({ from: "/login" });
  const {
    next = "/",
    client_id,
    redirect_uri,
    response_type,
    state,
    scope,
    code_challenge,
    code_challenge_method,
  } = searchParams;
  const authConfig = useAuthConfig();
  const { sso, emailAndPassword, magicLink, socialProviders } = authConfig;

  // Build OAuth authorize URL if this is an OAuth flow
  const oauthAuthorizeUrl = buildOAuthAuthorizeUrl({
    client_id,
    redirect_uri,
    response_type,
    state,
    scope,
    code_challenge,
    code_challenge_method,
  });

  // Determine where to redirect after login
  // If OAuth flow, redirect to authorize endpoint; otherwise use `next` param
  const redirectAfterLogin = oauthAuthorizeUrl || next;

  if (session.data) {
    // If OAuth flow, redirect to authorize endpoint to complete the flow
    if (oauthAuthorizeUrl) {
      window.location.href = oauthAuthorizeUrl;
      return <SplashScreen />;
    }
    return <Navigate to={next} />;
  }

  // In local mode, auto-login without showing any form
  if (authConfig.localMode) {
    return <AutoLogin redirectTo={redirectAfterLogin} />;
  }

  if (sso.enabled) {
    return (
      <RunSSO callbackURL={redirectAfterLogin} providerId={sso.providerId} />
    );
  }

  // Render unified auth form if any standard auth method is enabled
  if (
    emailAndPassword.enabled ||
    magicLink.enabled ||
    socialProviders.enabled
  ) {
    return (
      <main className="relative flex min-h-screen items-center justify-center bg-gradient-to-br from-brand to-brand/75 p-4">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `radial-gradient(circle, var(--brand-foreground) 1px, transparent 1px)`,
            backgroundSize: "16px 16px",
            opacity: 0.15,
          }}
        />

        <div className="relative z-10">
          {/* Blueprint lines - glued to card edges, extending full screen */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-screen h-px bg-brand-foreground/15" />
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-screen h-px bg-brand-foreground/15" />
          <div className="absolute left-0 top-1/2 -translate-y-1/2 w-px h-screen bg-brand-foreground/15" />
          <div className="absolute right-0 top-1/2 -translate-y-1/2 w-px h-screen bg-brand-foreground/15" />

          <UnifiedAuthForm redirectUrl={oauthAuthorizeUrl} />
        </div>
      </main>
    );
  }

  return <div>No login options available</div>;
}
