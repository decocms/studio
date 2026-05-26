/**
 * Create a per-import GitHub MCP connection and run OAuth (GitHub UI selects repos).
 * Each import session gets its own connection; the token is scoped to one repo
 * after the user picks it in the repo picker.
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
import { resolveGithubMcpConnectionUrl } from "@/shared/github-mcp-url";

type Status = "idle" | "installing" | "authenticating" | "ready" | "error";

export interface GithubImportTokenInfo {
  refreshToken?: string | null;
  expiresIn?: number | null;
  scope?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
  tokenEndpoint?: string | null;
}

interface UseGithubImportConnectionResult {
  status: Status;
  error: string | null;
  connection: ConnectionEntity | null;
  tokenInfo: GithubImportTokenInfo | null;
  retry: () => void;
}

const GITHUB_REGISTRY_APP_ID = "deco/mcp-github";

export function useGithubImportConnection(opts: {
  enabled: boolean;
}): UseGithubImportConnectionResult {
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const actions = useConnectionActions();
  const queryClient = useQueryClient();

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionEntity | null>(null);
  const [tokenInfo, setTokenInfo] = useState<GithubImportTokenInfo | null>(
    null,
  );

  const { data: registryItem, isLoading: isRegistryLoading } = useRegistryApp(
    GITHUB_REGISTRY_APP_ID,
    { enabled: opts.enabled },
  );

  const startedRef = useRef(false);

  if (
    opts.enabled &&
    registryItem &&
    !isRegistryLoading &&
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    !startedRef.current &&
    session?.user?.id &&
    status === "idle"
  ) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    startedRef.current = true;
    runImportConnectionFlow();
  }

  async function runImportConnectionFlow() {
    if (!registryItem || !session?.user?.id || !org) return;

    try {
      setStatus("installing");
      setError(null);
      setTokenInfo(null);

      const connectionData = extractConnectionData(
        registryItem,
        org.id,
        session.user.id,
        { remoteIndex: 0 },
      );

      connectionData.title = "GitHub (importing…)";
      if (connectionData.metadata) {
        (
          connectionData.metadata as Record<string, unknown>
        ).githubImportPending = true;
      }

      const remoteUrl = resolveGithubMcpConnectionUrl(
        connectionData.connection_url ?? undefined,
      );
      connectionData.connection_url = remoteUrl;

      const { id } = await actions.create.mutateAsync(connectionData);

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

      let savedTokenInfo: GithubImportTokenInfo | null = null;

      if (authStatus.supportsOAuth && !authStatus.isAuthenticated) {
        const {
          token,
          tokenInfo: oauthTokenInfo,
          error: oauthError,
        } = await authenticateMcp({
          connectionId: id,
          orgSlug: org.slug,
          scope: "offline_access",
        });

        if (oauthError || !token) {
          try {
            await actions.delete.mutateAsync(id);
          } catch {
            // Best-effort cleanup
          }
          throw new Error(oauthError ?? "No token received from GitHub");
        }

        if (oauthTokenInfo) {
          try {
            const response = await fetch(
              `/api/${org.slug}/connections/${id}/oauth-token`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({
                  accessToken: oauthTokenInfo.accessToken,
                  refreshToken: oauthTokenInfo.refreshToken,
                  expiresIn: oauthTokenInfo.expiresIn,
                  scope: oauthTokenInfo.scope,
                  clientId: oauthTokenInfo.clientId,
                  clientSecret: oauthTokenInfo.clientSecret,
                  tokenEndpoint: oauthTokenInfo.tokenEndpoint,
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

          savedTokenInfo = {
            refreshToken: oauthTokenInfo.refreshToken,
            expiresIn: oauthTokenInfo.expiresIn,
            scope: oauthTokenInfo.scope,
            clientId: oauthTokenInfo.clientId,
            clientSecret: oauthTokenInfo.clientSecret,
            tokenEndpoint: oauthTokenInfo.tokenEndpoint,
          };
        }
      }

      invalidateVirtualMcpQueries(queryClient, org.id);

      setConnection({ ...connectionData, id } as ConnectionEntity);
      setTokenInfo(savedTokenInfo);
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
    setTokenInfo(null);
    startedRef.current = false;
  }

  if (opts.enabled && isRegistryLoading && status === "idle") {
    return {
      status: "installing",
      error: null,
      connection: null,
      tokenInfo: null,
      retry,
    };
  }

  return { status, error, connection, tokenInfo, retry };
}

/** @deprecated Use useGithubImportConnection — kept for storefront checklist. */
export function useAutoInstallGitHub(opts: { enabled: boolean }) {
  const result = useGithubImportConnection(opts);
  return {
    status: result.status,
    error: result.error,
    connection: result.connection,
    retry: result.retry,
  };
}
