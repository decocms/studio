/**
 * GitTab — PR management panel for GitHub-linked virtualmcps.
 *
 * Replaces the "Instructions" tab when the vm has metadata.githubRepo set.
 * Renders one of four states based on the branch's PR status:
 *   A) No commits / no branch selected — empty-state with hint
 *   B) Commits exist, no PR — "Create PR" CTA
 *   C) PR open — title, body, external link, Merge button
 *   D) PR merged/closed — read-only summary
 *
 * All action buttons call `sendMessage` with a natural-language prompt from
 * message-templates.ts. The LLM executes the action via its GitHub tools.
 */

import { useProjectContext, useVirtualMCP } from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { GitBranch01, LinkExternal01 } from "@untitledui/icons";
import { MemoizedMarkdown } from "../../chat/markdown.tsx";
import { useChatTask } from "../../chat/index";
import { decodeHtmlEntities } from "./decode-html-entities.ts";
import { PrSubTabs } from "./pr-sub-tabs.tsx";
import { usePrByBranch, type PrSummary } from "./use-pr-data.ts";

/**
 * Minimal PR-number header shown at the top of the git panel whenever a
 * PR exists (open, closed, or merged). Click opens the PR on GitHub.
 */
function PrHeader({ pr }: { pr: PrSummary }) {
  return (
    <div className="flex h-12 items-center border-b border-border px-4 shrink-0">
      <a
        href={pr.htmlUrl}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open PR #${pr.number} on GitHub`}
        className="inline-flex items-center gap-1.5 text-base font-medium text-foreground hover:underline"
      >
        PR #{pr.number}
        <LinkExternal01 className="h-4 w-4 text-muted-foreground" />
      </a>
    </div>
  );
}

export function GitTab({ virtualMcpId }: { virtualMcpId: string }) {
  const { org } = useProjectContext();
  const vm = useVirtualMCP(virtualMcpId);
  const { currentBranch: branch } = useChatTask();

  const githubRepo = vm?.metadata?.githubRepo ?? null;

  if (!githubRepo?.connectionId) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        This virtualmcp is not linked to a GitHub repository.
      </div>
    );
  }

  if (!branch) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-sm">
        <GitBranch01 className="h-6 w-6 text-muted-foreground" />
        <div className="text-muted-foreground">No branch selected.</div>
        <div className="text-xs text-muted-foreground">
          Pick a branch from the header to see PR status.
        </div>
      </div>
    );
  }

  return (
    <GitTabContent
      orgId={org.id}
      orgSlug={org.slug}
      virtualMcpId={virtualMcpId}
      connectionId={githubRepo.connectionId}
      owner={githubRepo.owner}
      repo={githubRepo.name}
      branch={branch}
    />
  );
}

interface ContentProps {
  orgId: string;
  orgSlug: string;
  virtualMcpId: string;
  connectionId: string;
  owner: string;
  repo: string;
  branch: string;
}

function GitTabContent(props: ContentProps) {
  const { orgId, orgSlug, virtualMcpId, connectionId, owner, repo, branch } =
    props;

  const {
    data: pr,
    isLoading,
    isError,
  } = usePrByBranch({
    orgId,
    orgSlug,
    connectionId,
    owner,
    repo,
    branch,
  });

  const openExt = (url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
  };

  if (isLoading) {
    return (
      <div className="p-4 text-sm text-muted-foreground">Loading PR state…</div>
    );
  }

  if (isError) {
    return (
      <div className="p-4 text-sm text-destructive">
        Couldn't load PR state. The GitHub connection may be broken.
      </div>
    );
  }

  const branchUrl = `https://github.com/${owner}/${repo}/tree/${branch}`;

  // State D: merged / closed
  if (pr && pr.state === "closed") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PrHeader pr={pr} />
        <div className="flex flex-col gap-4 p-4 overflow-auto">
          <div className="text-sm text-success">
            {pr.merged ? "✓ Merged" : "✗ Closed"} into {pr.base}
            {pr.mergedAt && (
              <> · {new Date(pr.mergedAt).toLocaleDateString()}</>
            )}
            {pr.author && <> · by @{pr.author}</>}
          </div>
          <h1 className="text-lg font-semibold">
            {decodeHtmlEntities(pr.title)}
          </h1>
          {pr.body && (
            <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
              <MemoizedMarkdown
                id={`pr-body-${pr.number}`}
                text={decodeHtmlEntities(pr.body)}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  // State C: PR open
  if (pr && pr.state === "open") {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 w-full flex-1 flex-col px-6 py-5">
          <PrSubTabs
            pr={pr}
            virtualMcpId={virtualMcpId}
            branch={branch}
            connectionId={connectionId}
            owner={owner}
            repo={repo}
          />
        </div>
      </div>
    );
  }

  // State B: No PR yet
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="rounded-md border border-border bg-muted/30 p-4 text-sm">
        This branch doesn't have an open pull request. Click "Submit for review"
        in the header to open one; the agent will draft the title and summary
        from the current state of the branch.
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => openExt(branchUrl)}>
          <LinkExternal01 className="mr-1.5 h-4 w-4" />
          Open branch on GitHub
        </Button>
      </div>
    </div>
  );
}
