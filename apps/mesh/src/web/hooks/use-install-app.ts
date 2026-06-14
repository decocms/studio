/**
 * One-click app install — the exact flow the "Import GitHub" button uses, for any
 * registry app, run imperatively on click (no render-time trigger). Fetches the
 * app DETAIL (COLLECTION_REGISTRY_APP_GET, which carries connection methods),
 * creates the connection, then runs OAuth. Logs each step and surfaces failures
 * via toast so a click is never silent.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  authenticateMcp,
  isConnectionAuthenticated,
  useConnectionActions,
  useMCPClient,
  useProjectContext,
  WellKnownOrgMCPId,
} from "@decocms/mesh-sdk";
import { toast } from "sonner";
import { authClient } from "@/web/lib/auth-client";
import { extractConnectionData } from "@/web/utils/extract-connection-data";
import { invalidateVirtualMcpQueries } from "@/web/lib/query-keys";
import type { RegistryItem } from "@/web/components/store/types";

type Status = "idle" | "installing" | "authenticating" | "ready" | "error";

interface UseInstallAppResult {
  install: (appName?: string) => Promise<void>;
  status: Status;
  activeAppId: string | null;
  isBusy: boolean;
}

// COLLECTION_REGISTRY_APP_GET looks up by `name` like "deco/mcp-github" — strip a
// leading "@" so an "@deco/..." appName still resolves.
const normalizeAppId = (appId: string): string => appId.replace(/^@/, "");

export function useInstallApp(opts?: {
  onConnected?: () => void;
}): UseInstallAppResult {
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const actions = useConnectionActions();
  const queryClient = useQueryClient();
  const registryClient = useMCPClient({
    connectionId: WellKnownOrgMCPId.REGISTRY(org.id),
    orgId: org.id,
    orgSlug: org.slug,
  });

  const [status, setStatus] = useState<Status>("idle");
  const [activeAppId, setActiveAppId] = useState<string | null>(null);

  async function install(rawAppName?: string): Promise<void> {
    console.log("[telos-install] click", { rawAppName });
    if (!rawAppName) {
      toast.error("This goal tool has no app id — regenerate the goal");
      return;
    }
    if (!session?.user?.id || !org) {
      toast.error("Not signed in");
      return;
    }
    const appId = normalizeAppId(rawAppName);
    setActiveAppId(appId);
    setStatus("installing");

    // Open the OAuth window NOW, synchronously within the click gesture, so it
    // isn't popup-blocked after the awaits below (registry GET + create take
    // seconds). authenticateMcp's popup reuses the window named "mcp-oauth" —
    // navigating this already-open window, which browsers don't block.
    const oauthWindow = window.open(
      "about:blank",
      "mcp-oauth",
      "width=600,height=700",
    );

    try {
      // 1. Fetch the app DETAIL — this is what carries the connection methods.
      // GET resolves by SCOPED name ("deco/mcp-github"); if we were handed a bare
      // name, retry under the default "deco" scope so older/unscoped goals work.
      const candidates = appId.includes("/")
        ? [appId]
        : [appId, `deco/${appId}`];
      let item: RegistryItem | null = null;
      for (const name of candidates) {
        const res = (await registryClient.callTool({
          name: "COLLECTION_REGISTRY_APP_GET",
          arguments: { name },
        })) as { structuredContent?: { item?: RegistryItem } };
        item = res?.structuredContent?.item ?? null;
        console.log("[telos-install] registry GET", { name, found: !!item });
        if (item) break;
      }
      if (!item) {
        oauthWindow?.close();
        throw new Error(`App "${appId}" not found in the registry`);
      }

      // 2. Build connection data from the detail.
      const connectionData = extractConnectionData(
        item,
        org.id,
        session.user.id,
        { remoteIndex: 0 },
      );
      const isStdio = connectionData.connection_type === "STDIO";
      console.log("[telos-install] connectionData", {
        url: connectionData.connection_url,
        type: connectionData.connection_type,
      });
      if (!connectionData.connection_url && !isStdio) {
        oauthWindow?.close();
        throw new Error("No connection method available for this app");
      }

      // 3. Create the connection.
      const { id } = await actions.create.mutateAsync(connectionData);
      console.log("[telos-install] created connection", id);

      // 4. OAuth, if the server requires it.
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
      console.log("[telos-install] auth status", authStatus);

      if (authStatus.supportsOAuth && !authStatus.isAuthenticated) {
        const {
          token,
          tokenInfo,
          error: oauthError,
        } = await authenticateMcp({
          connectionId: id,
          orgSlug: org.slug,
          scope: "offline_access",
          // Redirect back to the origin the user is actually on (where the
          // /oauth/callback route is served). Without this, a global override
          // (setOAuthRedirectOrigin → internalUrl) can send the callback to a
          // port that doesn't serve the page. Mirrors the AI-provider dialog.
          callbackUrl: `${window.location.origin}/oauth/callback`,
        });
        // authenticateMcp drove its own "mcp-oauth" window; ours was reused.
        if (oauthError || !token) {
          try {
            await actions.delete.mutateAsync(id);
          } catch {
            // best-effort cleanup
          }
          throw new Error(oauthError ?? "Authentication failed");
        }
        if (tokenInfo) {
          try {
            const response = await fetch(
              `/api/${org.slug}/connections/${id}/oauth-token`,
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
      } else {
        // No OAuth needed — close the blank window we pre-opened.
        oauthWindow?.close();
      }

      invalidateVirtualMcpQueries(queryClient, org.id);
      setStatus("ready");
      toast.success("Connected");
      opts?.onConnected?.();
    } catch (err) {
      oauthWindow?.close();
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[telos-install] failed", msg, err);
      toast.error(msg);
      setStatus("error");
    }
  }

  return {
    install,
    status,
    activeAppId,
    isBusy: status === "installing" || status === "authenticating",
  };
}
