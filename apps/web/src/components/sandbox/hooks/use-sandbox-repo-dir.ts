import { buildSandboxUrl } from "@/sdk/sandbox-url";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";

export function useSandboxRepoDir(args: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  threadId: string | null;
  enabled?: boolean;
}) {
  const { orgSlug, virtualMcpId, branch, threadId, enabled = true } = args;
  const query = useQuery({
    queryKey: KEYS.sandboxRepoDir(orgSlug, virtualMcpId, branch, threadId),
    queryFn: async () => {
      const url = buildSandboxUrl(
        { orgSlug, virtualMcpId, branch, threadId },
        "config",
      );
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = (await res.json()) as { repoDir?: string | null };
      return data.repoDir ?? null;
    },
    enabled,
    staleTime: Infinity,
  });
  return query.data ?? null;
}
