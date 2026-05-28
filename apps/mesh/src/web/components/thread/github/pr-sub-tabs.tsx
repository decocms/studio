import { useState } from "react";
import { useProjectContext } from "@decocms/mesh-sdk";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@deco/ui/components/tabs.tsx";
import { LinkExternal01 } from "@untitledui/icons";
import { usePrDiff } from "@/web/components/sandbox/hooks/use-pr-diff.ts";
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
  connectionId: string;
  owner: string;
  repo: string;
}

type TabValue = "description" | "changes" | "checks";

export function PrSubTabs({
  pr,
  virtualMcpId,
  branch,
  connectionId,
  owner,
  repo,
}: Props) {
  const { org } = useProjectContext();
  const diffQuery = usePrDiff({
    orgSlug: org.slug,
    orgId: org.id,
    virtualMcpId,
    branch,
    base: pr.base,
    headSha: pr.headSha,
    pullNumber: pr.number,
    connectionId,
    owner,
    repo,
  });
  const diffCount = diffQuery.data
    ? countGitDiffFiles(diffQuery.data)
    : undefined;

  const [activeValue, setActiveValue] = useState<TabValue>("changes");

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
        <TabsList
          className="h-8 w-fit max-w-[600px] shrink-0"
          variant="pill"
        >
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
            <DescriptionTab
              pr={pr}
              connectionId={connectionId}
              owner={owner}
              repo={repo}
            />
          </TabsContent>
          <TabsContent value="changes" className="mt-0">
            <ChangesTab
              orgSlug={org.slug}
              orgId={org.id}
              virtualMcpId={virtualMcpId}
              branch={branch}
              connectionId={connectionId}
              owner={owner}
              repo={repo}
              pr={pr}
            />
          </TabsContent>
          <TabsContent value="checks" className="mt-0">
            <ChecksTab
              pr={pr}
              connectionId={connectionId}
              owner={owner}
              repo={repo}
            />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
