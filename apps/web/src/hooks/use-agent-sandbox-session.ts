import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";

export interface AgentSandboxSession {
  virtualMcpId: string;
  branch: string;
  sandboxHandle: string | null;
  previewUrl: string | null;
  sandboxApiUrl: string | null;
  desiredState: "running" | "stopped";
  status:
    | "provisioning"
    | "ready"
    | "missing"
    | "failed"
    | "stopping"
    | "reaping"
    | "deleting"
    | "stopped";
  startedWith: Record<string, unknown> | null;
  failureReason: string | null;
  updatedAt: string;
}

interface AgentSandboxSessionsResponse {
  items: AgentSandboxSession[];
}

async function fetchAgentSandboxSessions(
  orgSlug: string,
  virtualMcpId: string,
  branch?: string,
): Promise<AgentSandboxSession[]> {
  const query = branch ? `?branch=${encodeURIComponent(branch)}` : "";
  const response = await fetch(
    `/api/${orgSlug}/agent-sandbox-sessions/${virtualMcpId}${query}`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error("Failed to load sandbox sessions");
  const body = (await response.json()) as AgentSandboxSessionsResponse;
  return body.items;
}

export function useAgentSandboxSession(
  orgSlug: string,
  virtualMcpId: string,
  branch: string | null,
) {
  return useQuery({
    queryKey: KEYS.agentSandboxSession(orgSlug, virtualMcpId, branch ?? ""),
    queryFn: async (): Promise<AgentSandboxSession | null> => {
      if (!branch) return null;
      return (
        (await fetchAgentSandboxSessions(orgSlug, virtualMcpId, branch))[0] ??
        null
      );
    },
    enabled: !!branch,
    refetchInterval: 5_000,
  });
}

export function useAgentSandboxSessions(
  orgSlug: string,
  virtualMcpId: string,
  enabled = true,
) {
  return useQuery({
    queryKey: KEYS.agentSandboxSessions(orgSlug, virtualMcpId),
    queryFn: () => fetchAgentSandboxSessions(orgSlug, virtualMcpId),
    enabled,
  });
}
