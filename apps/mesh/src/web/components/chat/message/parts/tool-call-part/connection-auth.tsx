"use client";

import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { authenticateMcp, useProjectContext } from "@decocms/mesh-sdk";
import { Check, Loading01, Lock01 } from "@untitledui/icons";
import type { ToolUIPart } from "ai";
import { useState } from "react";
import { ToolCallShell } from "./common.tsx";
import { getEffectiveState } from "./utils.tsx";

interface ConnectionAuthData {
  connection_id: string;
  title: string;
  icon: string | null;
  description: string | null;
  connection_url: string | null;
  status: string;
  needs_auth: boolean;
  auth_type: "oauth" | "token" | "none";
}

interface ConnectionAuthPartProps {
  part: ToolUIPart;
}

function AuthCard({ data }: { data: ConnectionAuthData }) {
  const { org } = useProjectContext();

  const [authState, setAuthState] = useState<{
    checked: boolean;
    hasOAuthToken: boolean;
    hasToken: boolean;
    loading: boolean;
    success: boolean;
    error: string | null;
    useTokenFallback: boolean;
    tokenValue: string;
  }>(() => {
    // One-time async check: fire fetch on first render via setState initializer
    const initial = {
      checked: false,
      hasOAuthToken: false,
      hasToken: false,
      loading: false,
      success: false,
      error: null,
      useTokenFallback: false,
      tokenValue: "",
    };

    if (org?.id) {
      Promise.all([
        fetch(`/api/connections/${data.connection_id}/oauth-token/status`).then(
          (r) => r.json(),
        ),
        fetch(`/api/connections/${data.connection_id}/token/status`).then((r) =>
          r.json(),
        ),
      ])
        .then(([oauthStatus, tokenStatus]) => {
          setAuthState((prev) => ({
            ...prev,
            checked: true,
            hasOAuthToken: oauthStatus?.hasToken ?? false,
            hasToken: tokenStatus?.hasToken ?? false,
            success: oauthStatus?.hasToken || tokenStatus?.hasToken,
          }));
        })
        .catch(() => {
          setAuthState((prev) => ({ ...prev, checked: true }));
        });
    }

    return initial;
  });

  // Already authenticated
  if (authState.success || (!data.needs_auth && authState.checked)) {
    return (
      <ToolCallShell
        icon={<Check className="size-4 text-green-500" />}
        title={data.title}
        summary="Authenticated"
        state="idle"
      />
    );
  }

  const handleOAuth = async () => {
    setAuthState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const result = await authenticateMcp({
        connectionId: data.connection_id,
      });

      if (result.error) {
        // Fall back to token input if OAuth discovery fails
        if (
          result.error.includes("Protected Resource Metadata") ||
          result.error.includes("OAuth") ||
          result.error.includes("authorization server")
        ) {
          setAuthState((prev) => ({
            ...prev,
            loading: false,
            useTokenFallback: true,
          }));
          return;
        }
        setAuthState((prev) => ({
          ...prev,
          loading: false,
          error: result.error,
        }));
        return;
      }

      if (result.tokenInfo) {
        // Save OAuth token
        await fetch(`/api/connections/${data.connection_id}/oauth-token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accessToken: result.tokenInfo.accessToken,
            refreshToken: result.tokenInfo.refreshToken ?? null,
            expiresIn: result.tokenInfo.expiresIn ?? null,
            scope: result.tokenInfo.scope ?? null,
            clientId: result.tokenInfo.clientId ?? null,
            clientSecret: result.tokenInfo.clientSecret ?? null,
            tokenEndpoint: result.tokenInfo.tokenEndpoint ?? null,
          }),
        });
      }

      setAuthState((prev) => ({ ...prev, loading: false, success: true }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "OAuth failed";
      // Fall back to token input for OAuth discovery errors
      if (
        message.includes("Protected Resource Metadata") ||
        message.includes("OAuth") ||
        message.includes("authorization server")
      ) {
        setAuthState((prev) => ({
          ...prev,
          loading: false,
          useTokenFallback: true,
        }));
        return;
      }
      setAuthState((prev) => ({ ...prev, loading: false, error: message }));
    }
  };

  const handleTokenSave = async () => {
    if (!authState.tokenValue.trim()) return;
    setAuthState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      await fetch(`/api/connections/${data.connection_id}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: authState.tokenValue.trim() }),
      });
      setAuthState((prev) => ({ ...prev, loading: false, success: true }));
    } catch (err) {
      setAuthState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : "Failed to save token",
      }));
    }
  };

  const showTokenInput =
    data.auth_type === "token" || authState.useTokenFallback;

  return (
    <div className="flex flex-col gap-2">
      <ToolCallShell
        icon={<Lock01 className="size-4" />}
        title={data.title}
        summary="Authentication required"
        state="idle"
      />
      <div className="ml-6 flex flex-col gap-2 pb-2">
        {data.description && (
          <p className="text-xs text-muted-foreground">{data.description}</p>
        )}
        {authState.error && (
          <p className="text-xs text-destructive">{authState.error}</p>
        )}
        {showTokenInput ? (
          <div className="flex items-center gap-2">
            <Input
              type="password"
              placeholder="API key or token"
              value={authState.tokenValue}
              onChange={(e) =>
                setAuthState((prev) => ({
                  ...prev,
                  tokenValue: e.target.value,
                }))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") handleTokenSave();
              }}
              className="h-8 text-xs flex-1"
            />
            <Button
              size="sm"
              className="h-8 text-xs"
              disabled={authState.loading || !authState.tokenValue.trim()}
              onClick={handleTokenSave}
            >
              {authState.loading ? (
                <Loading01 className="size-3.5 animate-spin" />
              ) : (
                "Save"
              )}
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs w-fit"
            disabled={authState.loading}
            onClick={handleOAuth}
          >
            {authState.loading ? (
              <Loading01 className="size-3.5 animate-spin mr-1.5" />
            ) : (
              <Lock01 className="size-3.5 mr-1.5" />
            )}
            Authenticate with OAuth
          </Button>
        )}
      </div>
    </div>
  );
}

export function ConnectionAuthPart({ part }: ConnectionAuthPartProps) {
  const effectiveState = getEffectiveState(part.state);

  if (effectiveState === "loading") {
    return (
      <ToolCallShell
        icon={<Lock01 className="size-4" />}
        title="Checking connection auth..."
        state="loading"
      />
    );
  }

  // Extract auth data from tool output
  const output = part.output as ConnectionAuthData | undefined;
  if (!output?.connection_id) {
    return (
      <ToolCallShell
        icon={<Lock01 className="size-4" />}
        title="Connection Auth"
        summary="No auth data"
        state="idle"
      />
    );
  }

  return <AuthCard data={output} />;
}
