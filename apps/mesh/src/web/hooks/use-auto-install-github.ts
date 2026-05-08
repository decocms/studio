/**
 * Hook to auto-install the mcp-github connection from registry and run OAuth.
 * Used by the GitHub repo picker when no GitHub connection exists.
 */

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useConnectionActions,
  useProjectContext,
  type ConnectionEntity,
} from "@decocms/mesh-sdk";
import { authenticateMcp, isConnectionAuthenticated } from "@decocms/mesh-sdk";
import { authClient } from "@/web/lib/auth-client";
import { useRegistryApp } from "@/web/hooks/use-registry-app";
import { extractConnectionData } from "@/web/utils/extract-connection-data";
import { invalidateVirtualMcpQueries } from "@/web/lib/query-keys";

type Status = "idle" | "installing" | "authenticating" | "ready" | "error";

interface UseAutoInstallGitHubResult {
  status: Status;
  error: string | null;
  connection: ConnectionEntity | null;
  retry: () => void;
}

const GITHUB_APP_ID = "deco/mcp-github";

export function useAutoInstallGitHub(opts: {
  enabled: boolean;
}): UseAutoInstallGitHubResult {
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const actions = useConnectionActions();
  const queryClient = useQueryClient();

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionEntity | null>(null);

  const { data: registryItem, isLoading: isRegistryLoading } = useRegistryApp(
    GITHUB_APP_ID,
    { enabled: opts.enabled },
  );

  // Track whether we've started the flow to avoid re-triggering.
  // useRef (not useState) because refs mutate synchronously — prevents
  // duplicate fires under React 19 concurrent rendering / Strict Mode.
  const startedRef = useRef(false);

  // Auto-trigger when registry data arrives and we haven't started yet
  if (
    opts.enabled &&
    registryItem &&
    !isRegistryLoading &&
    !startedRef.current &&
    session?.user?.id &&
    status === "idle"
  ) {
    startedRef.current = true;
    runInstallFlow();
  }

  async function runInstallFlow() {
    if (!registryItem || !session?.user?.id || !org) return;

    try {
      // Step 1: Create connection from registry
      setStatus("installing");
      setError(null);

      const connectionData = extractConnectionData(
        registryItem,
        org.id,
        session.user.id,
        { remoteIndex: 0 },
      );

      const remoteUrl = connectionData.connection_url;
      if (!remoteUrl) {
        throw new Error("Registry item is missing a remote URL for mcp-github");
      }

      const { id } = await actions.create.mutateAsync(connectionData);

      // Step 2: Check if OAuth is needed
      setStatus("authenticating");
      const mcpProxyUrl = new URL(
        `/api/${org.slug}/mcp/${id}`,
        window.location.origin,
      );
      const authStatus = await isConnectionAuthenticated({
        url: mcpProxyUrl.href,
        token: null,
        orgId: org.id,
      });

      if (authStatus.supportsOAuth && !authStatus.isAuthenticated) {
        // Step 3: Run OAuth flow
        const {
          token,
          tokenInfo,
          error: oauthError,
        } = await authenticateMcp({
          connectionId: id,
          orgSlug: org.slug,
          scope: "offline_access",
        });

        if (oauthError || !token) {
          // OAuth failed or was cancelled — clean up the connection
          try {
            await actions.delete.mutateAsync(id);
          } catch {
            // Best-effort cleanup
          }
          throw new Error(oauthError ?? "No token received from GitHub");
        }

        // Step 4: Persist OAuth token
        if (tokenInfo) {
          try {
            const response = await fetch(
              `/api/${org.slug}/connections/${id}/oauth-token`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
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
              await actions.update.mutateAsync({
                id,
                data: { connection_token: token },
              });
            }
          } catch {
            await actions.update.mutateAsync({
              id,
              data: { connection_token: token },
            });
          }
        }
      }

      // Step 5: Invalidate connection queries so picker re-renders
      invalidateVirtualMcpQueries(queryClient, org.id);

      setConnection(connectionData as ConnectionEntity);
      setStatus("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  function retry() {
    setStatus("idle");
    setError(null);
    setConnection(null);
    startedRef.current = false;
  }

  // While registry is loading, show installing status
  if (opts.enabled && isRegistryLoading && status === "idle") {
    return { status: "installing", error: null, connection: null, retry };
  }

  return { status, error, connection, retry };
}
