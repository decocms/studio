import { useQuery } from "@tanstack/react-query";
import {
  fetchGitStatus,
  sandboxGitStatusQueryKey,
} from "../../thread/github/sandbox-git-api.ts";

export function useSandboxGitStatus(args: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string | null;
  enabled?: boolean;
}) {
  const { orgSlug, virtualMcpId, branch, enabled = true } = args;
  return useQuery({
    queryKey: sandboxGitStatusQueryKey(orgSlug, virtualMcpId, branch ?? ""),
    queryFn: () => fetchGitStatus(orgSlug, virtualMcpId, branch!),
    enabled: enabled && !!branch,
    refetchInterval: 3000,
    staleTime: 1000,
  });
}
