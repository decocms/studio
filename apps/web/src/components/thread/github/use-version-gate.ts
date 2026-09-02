import { useProjectContext } from "@/sdk";
import { authClient } from "@/lib/auth-client";
import { getActiveGithubRepo } from "@/lib/github-repo";
import {
  branchUserLabel,
  generateBranchName,
} from "@decocms/shared/branch-name";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { useT } from "@/i18n/use-t.ts";
import { useOptionalChatTask } from "@/components/chat/context";
import { usePrByBranch } from "./use-pr-data.ts";
import { nextReleaseColor, useReleases } from "./use-releases";

/**
 * The project's production branch — the PR base of the current branch, or "main"
 * as the app-wide fallback. Shared so "am I on production?" reads one source.
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

/**
 * True when the current branch is production (the base) — the read-only live
 * version people must branch off to edit.
 */
export function useIsOnProduction(
  virtualMcp: VirtualMCPEntity | null | undefined,
  currentBranch: string | null | undefined,
): boolean {
  const base = useBaseBranch(virtualMcp, currentBranch);
  return !!currentBranch && currentBranch === base;
}

/**
 * Creates a new named draft (a release) and switches editing onto it: mints a
 * branch, records the release, then re-points the current thread — or starts a
 * new one when the thread is locked. Shared by the switcher and the "start a new
 * draft to edit" CTAs shown on production.
 */
export function useCreateDraft(virtualMcpId: string) {
  const t = useT();
  const { data: session } = authClient.useSession();
  const userLabel = branchUserLabel(session?.user);
  const { releases, createRelease } = useReleases(virtualMcpId);
  const taskCtx = useOptionalChatTask();

  return async (name?: string) => {
    const branch = generateBranchName(userLabel);
    await createRelease({
      branch,
      name: name?.trim() || t("thread.branchPicker.defaultVersionName"),
      color: nextReleaseColor(releases.length),
      createdAt: new Date().toISOString(),
    });
    if (taskCtx?.isThreadLocked) taskCtx.createTask({ branch });
    else taskCtx?.setCurrentTaskBranch(branch);
    return branch;
  };
}
