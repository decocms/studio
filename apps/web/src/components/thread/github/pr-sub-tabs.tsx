import { useState } from "react";
import type { RepoToolTarget } from "@/lib/github-repo.ts";
import { useProjectContext } from "@/sdk";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@decocms/ui/components/tabs.tsx";
import { LinkExternal01 } from "@untitledui/icons";
import { usePrDiff } from "@/components/sandbox/hooks/use-pr-diff.ts";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import { countGitDiffFiles } from "./github-pr-diff.ts";
import { ChangesTab } from "./changes-tab.tsx";
import { ChecksTab } from "./checks-tab.tsx";
import { DescriptionTab } from "./description-tab.tsx";
import { decodeHtmlEntities } from "./decode-html-entities.ts";
import type { PrSummary } from "./use-pr-data.ts";

interface Props {
  pr: PrSummary;
  virtualMcpId: string;
  branch: string;
  target: RepoToolTarget;
  owner: string;
  repo: string;
}

type TabValue = "description" | "changes" | "checks";

export function PrSubTabs({
  pr,
  virtualMcpId,
  branch,
  target,
  owner,
  repo,
}: Props) {
  const { org } = useProjectContext();
  const [activeValue, setActiveValue] = useState<TabValue>("changes");

  /** File bodies are the panel's most expensive read — only load them on view. */
  const diffQuery = usePrDiff({
    orgSlug: org.slug,
    orgId: org.id,
    virtualMcpId,
    branch,
    threadId: useOptionalChatTask()?.taskId ?? null,
    base: pr.base,
    headSha: pr.headSha,
    pullNumber: pr.number,
    /**
     * The Changes tab reads the sandbox's own diff first; this is the fallback
     * for when the sandbox has none, and it is still GitHub-only (it walks
     * `get_file_contents` per file over the MCP connection). An empty
     * connection disables it, so a GitLab project shows the sandbox diff and
     * nothing else rather than erroring.
     */
    connectionId: target.connectionId ?? "",
    owner,
    repo,
    enabled: activeValue === "changes",
  });

  /** The PR read already knows the count; the bodies only confirm it. */
  const diffCount =
    pr.changedFiles ??
    (diffQuery.data ? countGitDiffFiles(diffQuery.data) : undefined);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-3 pb-4">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold leading-tight">
            {decodeHtmlEntities(pr.title)}
          </h1>
          <div className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
            <a
              href={pr.htmlUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open PR #${pr.number} on GitHub`}
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              PR #{pr.number}
              <LinkExternal01 className="h-3.5 w-3.5" />
            </a>
            {pr.author ? (
              <>
                <span>·</span>
                <span>@{pr.author}</span>
              </>
            ) : null}
            <span>·</span>
            <span className="font-mono text-xs">{pr.base}</span>
            <span>←</span>
            <span className="font-mono text-xs">{pr.head}</span>
          </div>
        </div>
      </div>

      <Tabs
        value={activeValue}
        onValueChange={(value) => setActiveValue(value as TabValue)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="h-8 w-fit max-w-[600px] shrink-0" variant="pill">
          <TabsTrigger value="description" className="px-3 text-xs">
            Description
          </TabsTrigger>
          <TabsTrigger value="changes" className="px-3 text-xs">
            Changes{diffCount !== undefined ? ` ${diffCount}` : ""}
          </TabsTrigger>
          <TabsTrigger value="checks" className="px-3 text-xs">
            Checks
          </TabsTrigger>
        </TabsList>

        <div className="min-h-0 flex-1 overflow-y-auto pt-5">
          <TabsContent value="description" className="mt-0">
            <DescriptionTab pr={pr} target={target} owner={owner} repo={repo} />
          </TabsContent>
          <TabsContent value="changes" className="mt-0">
            <ChangesTab diffQuery={diffQuery} />
          </TabsContent>
          <TabsContent value="checks" className="mt-0">
            <ChecksTab pr={pr} target={target} owner={owner} repo={repo} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
