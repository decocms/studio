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
import { authClient } from "@/web/lib/auth-client";
import { invalidateVirtualMcpQueries, KEYS } from "@/web/lib/query-keys";
import { runOAuthHandshake } from "@/web/hooks/use-oauth-handshake";

type Status = "idle" | "installing" | "authenticating" | "ready" | "error";

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
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  onReadyRef.current = opts.onReady;

  if (
    opts.enabled &&
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    !startedRef.current &&
    session?.user?.id &&
    org &&
    status === "idle"
  ) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
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
      const result = await runOAuthHandshake({
        connectionId,
        org: { id: org.id, slug: org.slug },
      });
      if (!result.ok) throw new Error(result.error);

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
