import { useProjectContext } from "@/sdk";
import { getActiveRepository, repoToolTarget } from "@/lib/repository-binding";
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
  const repo = getActiveRepository(virtualMcp);
  return (
    usePrByBranch({
      orgId: org.id,
      orgSlug: org.slug,
      target: repoToolTarget(repo),
      owner: repo?.owner ?? "",
      repo: repo?.name ?? "",
      branch: currentBranch ?? null,
    }).data?.base ?? "main"
  );
}
