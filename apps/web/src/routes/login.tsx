import { AuthEntry } from "@/components/auth-entry";
import { AuthSplitLayout } from "@/components/auth-split-layout";
import { SplashScreen } from "@/components/splash-screen";
import { authClient } from "@/lib/auth-client";
import { Navigate, useSearch } from "@tanstack/react-router";

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

export default function LoginRoute() {
  const session = authClient.useSession();
  const searchParams = useSearch({ from: "/login" });
  const {
    next: rawNext = "/",
    client_id,
    redirect_uri,
    response_type,
    state,
    scope,
    code_challenge,
    code_challenge_method,
  } = searchParams;

  // Prevent open redirect — only allow relative paths
  const next =
    rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";

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

  if (session.data) {
    // If OAuth flow, redirect to authorize endpoint to complete the flow
    if (oauthAuthorizeUrl) {
      window.location.href = oauthAuthorizeUrl;
      return <SplashScreen />;
    }
    return <Navigate to={next} />;
  }

  return (
    <AuthSplitLayout>
      <AuthEntry callbackUrl={next} redirectUrl={oauthAuthorizeUrl} />
    </AuthSplitLayout>
  );
}
