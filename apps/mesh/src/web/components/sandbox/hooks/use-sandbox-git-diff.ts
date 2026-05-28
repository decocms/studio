import { useQuery } from "@tanstack/react-query";
import {
  fetchGitDiff,
  type GitDiffResult,
} from "../../thread/github/sandbox-git-api.ts";

export function sandboxGitDiffQueryKey(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
  base?: string | null,
) {
  return [
    "sandbox-git-diff",
    orgSlug,
    virtualMcpId,
    branch,
    base ?? "",
  ] as const;
}

export function useSandboxGitDiff(args: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string | null;
  /** When set, diff committed changes on the branch since `origin/{base}`. */
  base?: string | null;
  enabled?: boolean;
}) {
  const { orgSlug, virtualMcpId, branch, base, enabled = true } = args;
  return useQuery<GitDiffResult>({
    queryKey: sandboxGitDiffQueryKey(orgSlug, virtualMcpId, branch ?? "", base),
    queryFn: () =>
      fetchGitDiff(orgSlug, virtualMcpId, branch!, base ? { base } : undefined),
    enabled: enabled && !!branch,
    refetchInterval: 3000,
    staleTime: 1000,
  });
}
