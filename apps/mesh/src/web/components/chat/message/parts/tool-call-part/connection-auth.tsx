"use client";

import { Button } from "@deco/ui/components/button.tsx";
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

type AuthState = "idle" | "authenticating" | "success" | "error";

function AuthCard({ data }: { data: AuthData }) {
  const [authState, setAuthState] = useState<AuthState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const connected = authState === "success" || !data.needs_auth;

  const handleAuthenticate = async () => {
    setAuthState("authenticating");
    setErrorMsg(null);
    try {
      const result = await authenticateMcp({
        connectionId: data.connection_id,
      });
      if (result.token) {
        // Save the OAuth token to the connection so it persists
        if (result.tokenInfo) {
          try {
            const res = await fetch(
              `/api/connections/${data.connection_id}/oauth-token`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({
                  accessToken: result.tokenInfo.accessToken,
                  refreshToken: result.tokenInfo.refreshToken,
                  expiresIn: result.tokenInfo.expiresIn,
                  scope: result.tokenInfo.scope,
                  clientId: result.tokenInfo.clientId,
                  clientSecret: result.tokenInfo.clientSecret,
                  tokenEndpoint: result.tokenInfo.tokenEndpoint,
                }),
              },
            );
            if (!res.ok) {
              // Fallback: save raw token
              await fetch(`/api/connections/${data.connection_id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ connection_token: result.token }),
              });
            }
          } catch {
            // Fallback: save raw token
            await fetch(`/api/connections/${data.connection_id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ connection_token: result.token }),
            });
          }
        } else {
          // No tokenInfo, save raw token
          await fetch(`/api/connections/${data.connection_id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ connection_token: result.token }),
          });
        }
        setAuthState("success");
      } else {
        setAuthState("error");
        setErrorMsg(result.error ?? "Authentication failed");
      }
    } catch (err) {
      setAuthState("error");
      setErrorMsg(err instanceof Error ? err.message : "Authentication failed");
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
        {data.description && (
          <p className="text-xs text-muted-foreground truncate">
            {data.description}
          </p>
        )}
        {authState === "error" && errorMsg && (
          <p className="text-xs text-destructive mt-0.5">{errorMsg}</p>
        )}
      </div>
      {!connected && (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 h-7 text-xs"
          onClick={handleAuthenticate}
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
            ? data.needs_auth
              ? `${data.title} needs authentication`
              : `${data.title} is connected`
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
