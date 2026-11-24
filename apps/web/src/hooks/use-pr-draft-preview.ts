import { useState } from "react";
import type { Release, VirtualMCPEntity } from "@decocms/shared/sdk/types";
import {
  fastPreviewCapability,
  type ThreadRuntime,
} from "@decocms/shared/thread/session-runtime";
import { blocksV8Project } from "@/hooks/use-blocks-v8-project";
import {
  repoToolTarget,
  resolveRepositoryAttachment,
} from "@/lib/repository-binding.ts";
import { useProjectContext } from "@/sdk";
import {
  type PreviewState,
  useDeploymentPreview,
  usePrPreview,
} from "@/components/thread/repository/use-pr-data.ts";

/**
 * Whether a project opens pull requests as drafts: its switch
 * (`metadata.pullRequestDrafts`), which lives under Fast Preview.
 */
export function pullRequestDraftsEnabled(
  project: VirtualMCPEntity | null | undefined,
): boolean {
  const metadata = project?.metadata;
  return (
    metadata?.pullRequestDrafts === true &&
    fastPreviewCapability(metadata) &&
    !blocksV8Project(project)
  );
}

/**
 * A CMS session on a pull request draft (`Release.preview`): rendered on the
 * pull request's deploy preview, so the code it changes shows beside the
 * branch's content.
 */
export function isPullRequestDraft(input: {
  enabled: boolean;
  runtime: ThreadRuntime;
  releases: readonly Release[];
  branch: string | null;
}): boolean {
  if (!input.enabled || input.runtime !== "cms" || !input.branch) {
    return false;
  }
  return input.releases.some(
    (r) => r.branch === input.branch && r.preview === "pull-request",
  );
}

/** A pull request draft's preview: `pending` until the first read lands. */
export interface PrDraftPreview {
  state: PreviewState | "pending";
  /** The deploy preview it renders on, once one is known. */
  url: string | null;
  /** The pull request on its provider. */
  htmlUrl: string | null;
}

/**
 * What a pull request draft renders on, or `null` when the session is not
 * one. Its CI runs answer first; without a known preview run,
 * the head's deployments do.
 *
 * The URL is kept once found: a push (each CMS save is one) starts a new
 * deploy, and the read in between can name no preview at all. The last one
 * still renders the branch's newest content through `?__draft=`.
 */
export function usePrDraftPreview(input: {
  project: VirtualMCPEntity | null | undefined;
  branch: string | null;
  runtime: ThreadRuntime;
}): PrDraftPreview | null {
  const { org } = useProjectContext();
  const { project, branch } = input;
  const active = isPullRequestDraft({
    enabled: pullRequestDraftsEnabled(project),
    runtime: input.runtime,
    releases: project?.metadata?.releases ?? [],
    branch,
  });
  const attachment = resolveRepositoryAttachment(project);
  const repository =
    active &&
    (attachment.status === "attached" || attachment.status === "public-clone")
      ? attachment.repo
      : null;
  const repoArgs = {
    orgId: org.id,
    orgSlug: org.slug,
    target: repoToolTarget(repository),
    owner: repository?.owner ?? "",
    repo: repository?.name ?? "",
  };
  const pr = usePrPreview({ ...repoArgs, branch: active ? branch : null });
  const fromRuns = pr.data ?? null;
  const deployment = useDeploymentPreview({
    ...repoArgs,
    sha: fromRuns?.headSha ?? null,
    enabled: active && fromRuns?.state === "none",
  });
  const fresh =
    fromRuns?.state === "none" ? (deployment.data ?? null) : fromRuns;

  const [kept, setKept] = useState<{ branch: string; url: string } | null>(
    null,
  );
  if (
    fresh?.url &&
    branch &&
    (kept?.branch !== branch || kept.url !== fresh.url)
  ) {
    setKept({ branch, url: fresh.url });
  }
  if (!active) return null;
  const url = fresh?.url ?? (kept?.branch === branch ? kept.url : null);
  return {
    state: url ? "ready" : (fresh?.state ?? "pending"),
    url,
    htmlUrl: fromRuns?.htmlUrl ?? null,
  };
}
