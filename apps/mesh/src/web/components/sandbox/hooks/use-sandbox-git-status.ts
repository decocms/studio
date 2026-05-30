import { useQuery } from "@tanstack/react-query";
import {
  fetchGitStatus,
  isSandboxUnreachable,
  sandboxGitStatusQueryKey,
} from "../../thread/github/sandbox-git-api.ts";

const BASE_INTERVAL_MS = 3000;
const MAX_INTERVAL_MS = 60_000;

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
    // Keep polling, but back off when the sandbox is unreachable (no runner /
    // gone) so a dead VM doesn't flood 503s every 3s. Exponential per
    // consecutive failure, capped at 60s; snaps back to 3s once it recovers.
    refetchInterval: (query) => {
      if (!isSandboxUnreachable(query.state.error)) return BASE_INTERVAL_MS;
      const failures = query.state.fetchFailureCount;
      return Math.min(BASE_INTERVAL_MS * 2 ** failures, MAX_INTERVAL_MS);
    },
    retry: (_count, error) => !isSandboxUnreachable(error),
    staleTime: 1000,
  });
}
