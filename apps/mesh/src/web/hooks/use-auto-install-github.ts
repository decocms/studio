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
import { authClient } from "@/web/lib/auth-client";
import { useRegistryApp } from "@/web/hooks/use-registry-app";
import { extractConnectionData } from "@/web/utils/extract-connection-data";
import { invalidateVirtualMcpQueries, KEYS } from "@/web/lib/query-keys";
import { runOAuthHandshake } from "@/web/hooks/use-oauth-handshake";

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
      setStatus("installing");
      setError(null);

      const connectionData = extractConnectionData(
        registryItem,
        org.id,
        session.user.id,
        { remoteIndex: 0 },
      );
      if (!connectionData.connection_url) {
        throw new Error("Registry item is missing a remote URL for mcp-github");
      }
      const { id } = await actions.create.mutateAsync(connectionData);

      setStatus("authenticating");
      const result = await runOAuthHandshake({
        connectionId: id,
        org: { id: org.id, slug: org.slug },
        onOAuthFailure: async (cid) => {
          await actions.delete.mutateAsync(cid);
        },
        onPersistFallback: async (cid, token) => {
          await actions.update.mutateAsync({
            id: cid,
            data: { connection_token: token },
          });
        },
      });
      if (!result.ok) throw new Error(result.error);

      // Invalidate connection queries so picker re-renders.
      // Also nudge the preset-tasks query — the "Install GitHub" card
      // resolves off the existence of an mcp-github connection, so the
      // home panel needs to flip to the next phase regardless of which
      // surface triggered the install.
      invalidateVirtualMcpQueries(queryClient, org.id);
      queryClient.invalidateQueries({ queryKey: KEYS.presetTasks(org.slug) });

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
