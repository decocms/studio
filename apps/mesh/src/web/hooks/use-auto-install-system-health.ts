/**
 * Hook to auto-install the system-health MCP connection and force the
 * user through OAuth. Used by the error-monitoring preset card when the
 * resolver flags the org as "needs-install".
 *
 * Mirrors `useAutoInstallGitHub` but the connection itself is created
 * server-side by `POST /preset-tasks/error-monitoring/install` (which
 * reads `process.env.DECO_SYSTEM_HEALTH_MCP`). Once the connection id
 * comes back the flow is identical: probe → OAuth → persist token.
 */

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@decocms/mesh-sdk";
import { authenticateMcp, isConnectionAuthenticated } from "@decocms/mesh-sdk";
import { authClient } from "@/web/lib/auth-client";
import { invalidateVirtualMcpQueries, KEYS } from "@/web/lib/query-keys";

type Status =
  | "idle"
  | "installing"
  | "authenticating"
  | "ready"
  | "error"
  | "cancelled";

interface UseAutoInstallSystemHealthOptions {
  enabled: boolean;
  onReady?: (connectionId: string, virtualMcpId: string) => void;
}

interface UseAutoInstallSystemHealthResult {
  status: Status;
  error: string | null;
  retry: () => void;
}

interface InstallResponse {
  connectionId: string;
  virtualMcpId: string;
}

export function useAutoInstallSystemHealth(
  opts: UseAutoInstallSystemHealthOptions,
): UseAutoInstallSystemHealthResult {
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const queryClient = useQueryClient();

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  const startedRef = useRef(false);
  const onReadyRef = useRef(opts.onReady);
  onReadyRef.current = opts.onReady;

  if (
    opts.enabled &&
    !startedRef.current &&
    session?.user?.id &&
    status === "idle"
  ) {
    startedRef.current = true;
    runInstallFlow();
  }

  async function runInstallFlow() {
    if (!session?.user?.id || !org) return;

    try {
      setStatus("installing");
      setError(null);

      const installRes = await fetch(
        `/api/${org.slug}/preset-tasks/error-monitoring/install`,
        { method: "POST", credentials: "include" },
      );
      if (!installRes.ok) {
        const body = (await installRes.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? "Failed to install system health");
      }
      const { connectionId, virtualMcpId } =
        (await installRes.json()) as InstallResponse;

      setStatus("authenticating");
      const mcpProxyUrl = new URL(
        `/api/${org.slug}/mcp/${connectionId}`,
        window.location.origin,
      );
      const authStatus = await isConnectionAuthenticated({
        url: mcpProxyUrl.href,
        token: null,
        orgId: org.id,
      });

      if (authStatus.supportsOAuth && !authStatus.isAuthenticated) {
        const {
          token,
          tokenInfo,
          error: oauthError,
        } = await authenticateMcp({
          connectionId,
          orgSlug: org.slug,
          scope: "offline_access",
        });

        if (oauthError || !token) {
          throw new Error(oauthError ?? "No token received from system health");
        }

        if (tokenInfo) {
          const response = await fetch(
            `/api/${org.slug}/connections/${connectionId}/oauth-token`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                accessToken: tokenInfo.accessToken,
                refreshToken: tokenInfo.refreshToken,
                expiresIn: tokenInfo.expiresIn,
                scope: tokenInfo.scope,
                clientId: tokenInfo.clientId,
                clientSecret: tokenInfo.clientSecret,
                tokenEndpoint: tokenInfo.tokenEndpoint,
              }),
            },
          );
          if (!response.ok) {
            const body = (await response.json().catch(() => ({}))) as {
              error?: string;
            };
            throw new Error(
              body.error ?? "Failed to persist system health token",
            );
          }
        }
      }

      invalidateVirtualMcpQueries(queryClient, org.id);
      queryClient.invalidateQueries({ queryKey: KEYS.presetTasks(org.slug) });
      setStatus("ready");
      onReadyRef.current?.(connectionId, virtualMcpId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  function retry() {
    setStatus("idle");
    setError(null);
    startedRef.current = false;
  }

  return { status, error, retry };
}
