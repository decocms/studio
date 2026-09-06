import { useProjectContext } from "@/sdk";
import { getActiveGithubRepo } from "@/lib/github-repo";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { usePrByBranch } from "./use-pr-data.ts";

/**
 * The project's production branch — the PR base of the current branch, or "main"
 * as the app-wide fallback. Shared so publish and entry read one source.
 */
export function useBaseBranch(
  virtualMcp: VirtualMCPEntity | null | undefined,
  currentBranch: string | null | undefined,
): string {
  const { org } = useProjectContext();
  const repo = getActiveGithubRepo(virtualMcp);
  return (
    usePrByBranch({
      orgId: org.id,
      orgSlug: org.slug,
      connectionId: repo?.connectionId ?? "",
      owner: repo?.owner ?? "",
      repo: repo?.name ?? "",
      branch: currentBranch ?? null,
    }).data?.base ?? "main"
  );
}

/**
 * Per-agent "Draft & Releases mode" flag. Off (default) keeps the classic
 * branch/PR picker and post-publish behavior; on gates the drafts UX.
 */
export function draftsModeEnabled(
  virtualMcp: VirtualMCPEntity | null | undefined,
): boolean {
  return virtualMcp?.metadata?.draftsMode === true;
}
