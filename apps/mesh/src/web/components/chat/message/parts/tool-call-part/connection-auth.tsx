"use client";

import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { authenticateMcp } from "@decocms/mesh-sdk";
import { Check, Loading01, Lock01 } from "@untitledui/icons";
import type { ToolUIPart } from "ai";
import { useState } from "react";
import { ToolCallShell } from "./common.tsx";
import { getEffectiveState } from "./utils.tsx";

interface AuthData {
  connection_id: string;
  title: string;
  icon: string | null;
  description: string | null;
  connection_url: string | null;
  status: string;
  needs_auth: boolean;
  auth_type: string;
}

function parseAuthData(output: unknown): AuthData | null {
  if (!output || typeof output !== "object") return null;
  const data = output as Record<string, unknown>;
  if (!data.connection_id || typeof data.connection_id !== "string") {
    return null;
  }
  return {
    connection_id: data.connection_id as string,
    title: (data.title as string) ?? "Connection",
    icon: (data.icon as string) ?? null,
    description: (data.description as string) ?? null,
    connection_url: (data.connection_url as string) ?? null,
    status: (data.status as string) ?? "inactive",
    needs_auth: (data.needs_auth as boolean) ?? true,
    auth_type: (data.auth_type as string) ?? "oauth",
  };
}

type AuthState = "idle" | "checking" | "authenticating" | "success" | "error";

function AuthCard({ data }: { data: AuthData }) {
  // If OAuth fails (e.g. server doesn't support it), fall back to token input
  const [oauthFailed, setOauthFailed] = useState(false);
  const isTokenAuth =
    oauthFailed ||
    data.auth_type === "configuration" ||
    data.auth_type === "token";

  const [authState, setAuthState] = useState<AuthState>(() => {
    if (!data.needs_auth) return "success";
    return "checking";
  });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");

  // Check live auth status (runs once via useState initializer + async update)
  const [checked, setChecked] = useState(false);
  if (!checked && authState === "checking" && data.connection_id) {
    setChecked(true);

    // Check both OAuth token and connection_token status
    const oauthCheck = fetch(
      `/api/connections/${data.connection_id}/oauth-token/status`,
      { credentials: "include" },
    )
      .then((res) => res.json())
      .then(
        (s: { hasToken?: boolean; isExpired?: boolean }) =>
          s.hasToken && !s.isExpired,
      )
      .catch(() => false);

    const tokenCheck = fetch(
      `/api/connections/${data.connection_id}/token/status`,
      { credentials: "include" },
    )
      .then((res) => res.json())
      .then((s: { hasToken?: boolean }) => !!s.hasToken)
      .catch(() => false);

    Promise.all([oauthCheck, tokenCheck]).then(([hasOAuth, hasToken]) => {
      if (hasOAuth || hasToken) {
        setAuthState("success");
      } else {
        setAuthState("idle");
      }
    });
  }

  const connected = authState === "success";

  const handleOAuthAuthenticate = async () => {
    setAuthState("authenticating");
    setErrorMsg(null);
    try {
      const result = await authenticateMcp({
        connectionId: data.connection_id,
      });
      if (!result.token) {
        const errMsg = result.error ?? "Authentication failed";
        // If OAuth discovery failed, fall back to token input
        if (
          errMsg.includes("Protected Resource Metadata") ||
          errMsg.includes("OAuth") ||
          errMsg.includes("authorization server")
        ) {
          setOauthFailed(true);
          setAuthState("idle");
          setErrorMsg(null);
          return;
        }
        setAuthState("error");
        setErrorMsg(errMsg);
        return;
      }

      const tokenPayload = result.tokenInfo
        ? {
            accessToken: result.tokenInfo.accessToken,
            refreshToken: result.tokenInfo.refreshToken,
            expiresIn: result.tokenInfo.expiresIn,
            scope: result.tokenInfo.scope,
            clientId: result.tokenInfo.clientId,
            clientSecret: result.tokenInfo.clientSecret,
            tokenEndpoint: result.tokenInfo.tokenEndpoint,
          }
        : { accessToken: result.token };

      const saveRes = await fetch(
        `/api/connections/${data.connection_id}/oauth-token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(tokenPayload),
        },
      );

      if (!saveRes.ok) {
        const errText = await saveRes.text().catch(() => "unknown error");
        console.error(
          "[auth-card] Failed to save token:",
          saveRes.status,
          errText,
        );
      }

      setAuthState("success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Authentication failed";
      // If OAuth discovery failed, fall back to token input
      if (
        msg.includes("Protected Resource Metadata") ||
        msg.includes("OAuth") ||
        msg.includes("authorization server")
      ) {
        setOauthFailed(true);
        setAuthState("idle");
        setErrorMsg(null);
        return;
      }
      setAuthState("error");
      setErrorMsg(msg);
    }
  };

  const handleTokenSave = async () => {
    if (!apiKey.trim()) return;
    setAuthState("authenticating");
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/connections/${data.connection_id}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token: apiKey.trim() }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "unknown error");
        throw new Error(errText);
      }
      setAuthState("success");
    } catch (err) {
      setAuthState("error");
      setErrorMsg(
        err instanceof Error ? err.message : "Failed to save API key",
      );
    }
  };

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border px-3 py-2.5 mt-2",
        connected ? "border-green-200 bg-green-50" : "border-border",
      )}
    >
      <div className="h-8 w-8 shrink-0 flex items-center justify-center rounded-md bg-muted">
        {data.icon ? (
          <img
            src={data.icon}
            alt={data.title}
            className="h-6 w-6 rounded object-cover"
          />
        ) : (
          <Lock01 size={16} className="text-muted-foreground" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium">{data.title}</span>
          {connected && <Check size={14} className="text-green-600 shrink-0" />}
        </div>
        {connected && data.description && (
          <p className="text-xs text-muted-foreground truncate">
            {data.description}
          </p>
        )}
        {/* Inline API key input for token/configuration auth */}
        {!connected && isTokenAuth && authState !== "checking" && (
          <form
            className="flex items-center gap-1.5 mt-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              handleTokenSave();
            }}
          >
            <Input
              type="password"
              placeholder="Enter API key..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="h-7 text-xs flex-1"
              disabled={authState === "authenticating"}
              autoFocus
            />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              className="shrink-0 h-7 text-xs"
              disabled={!apiKey.trim() || authState === "authenticating"}
            >
              {authState === "authenticating" ? (
                <Loading01 size={12} className="animate-spin" />
              ) : (
                "Save"
              )}
            </Button>
          </form>
        )}
        {authState === "error" && errorMsg && (
          <p className="text-xs text-destructive mt-0.5">{errorMsg}</p>
        )}
      </div>
      {/* OAuth authenticate button */}
      {!connected && !isTokenAuth && authState !== "checking" && (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 h-7 text-xs"
          onClick={handleOAuthAuthenticate}
          disabled={authState === "authenticating"}
        >
          {authState === "authenticating" ? (
            <Loading01 size={12} className="animate-spin" />
          ) : authState === "error" ? (
            "Retry"
          ) : (
            "Authenticate"
          )}
        </Button>
      )}
      {authState === "checking" && (
        <Loading01 size={12} className="animate-spin text-muted-foreground" />
      )}
    </div>
  );
}

interface ConnectionAuthPartProps {
  part: ToolUIPart;
  latency?: number;
}

export function ConnectionAuthPart({ part, latency }: ConnectionAuthPartProps) {
  const effectiveState = getEffectiveState(part.state);
  const data =
    part.state === "output-available" ? parseAuthData(part.output) : null;

  return (
    <div>
      <ToolCallShell
        icon={<Lock01 className="size-4 text-muted-foreground" />}
        title="Authenticate Connection"
        summary={
          data
            ? `${data.title}`
            : effectiveState === "loading"
              ? "Checking..."
              : ""
        }
        state={effectiveState === "approval" ? "idle" : effectiveState}
        detail={null}
        latency={latency}
      />
      {data && <AuthCard data={data} />}
    </div>
  );
}
