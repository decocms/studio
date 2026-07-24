import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";

export function useSandboxRepoDir(args: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  enabled?: boolean;
}) {
  const { orgSlug, virtualMcpId, branch, enabled = true } = args;
  const query = useQuery({
    queryKey: KEYS.sandboxRepoDir(orgSlug, virtualMcpId, branch),
    queryFn: async () => {
      const url = `/api/${orgSlug}/sandbox/${encodeURIComponent(virtualMcpId)}/${encodeURIComponent(branch)}/config`;
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
