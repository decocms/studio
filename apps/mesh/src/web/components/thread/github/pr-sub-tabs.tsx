import { useRef, useState } from "react";
import { useProjectContext } from "@decocms/mesh-sdk";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@deco/ui/components/tabs.tsx";
import { ChangesTab } from "./changes-tab.tsx";
import { ChecksTab } from "./checks-tab.tsx";
import { DescriptionTab } from "./description-tab.tsx";
import { usePrFiles, type PrSummary } from "./use-pr-data.ts";

interface Props {
  pr: PrSummary;
  connectionId: string;
  owner: string;
  repo: string;
}

type TabValue = "description" | "changes" | "checks";

/**
 * Sub-tab container for State C (PR open). Description | Changes {n}
 * | Checks. Each sub-tab owns its data fetch via the hooks in
 * use-pr-data.ts; this wrapper only handles layout + tab state.
 *
 * We call `usePrFiles` here (not only inside ChangesTab) so the tab
 * label can show the file count even before the user opens the tab.
 * React Query dedupes the call when ChangesTab mounts.
 *
 * The active underline is a single absolute-positioned element that
 * slides between triggers. Per-trigger `border-primary` is overridden
 * to transparent so only the sliding indicator is visible.
 */
export function PrSubTabs({ pr, connectionId, owner, repo }: Props) {
  const { org } = useProjectContext();
  const filesQuery = usePrFiles({
    orgId: org.id,
    orgSlug: org.slug,
    connectionId,
    owner,
    repo,
    prNumber: pr.number,
  });
  const fileCount = filesQuery.data?.length;

  const [activeValue, setActiveValue] = useState<TabValue>("description");
  const triggerRefs = useRef<Record<TabValue, HTMLButtonElement | null>>({
    description: null,
    changes: null,
    checks: null,
  });
  const [indicator, setIndicator] = useState<{
    left: number;
    width: number;
  } | null>(null);

  const refFor = (value: TabValue) => (el: HTMLButtonElement | null) => {
    triggerRefs.current[value] = el;
    if (el && value === activeValue) {
      const left = el.offsetLeft;
      const width = el.offsetWidth;
      if (
        indicator === null ||
        left !== indicator.left ||
        width !== indicator.width
      ) {
        setIndicator({ left, width });
      }
    }
  };

  const handleValueChange = (value: string) => {
    const v = value as TabValue;
    setActiveValue(v);
    const el = triggerRefs.current[v];
    if (el) {
      setIndicator({ left: el.offsetLeft, width: el.offsetWidth });
    }
  };

  return (
    <Tabs
      value={activeValue}
      onValueChange={handleValueChange}
      variant="underline"
    >
      <TabsList variant="underline" className="relative h-auto p-0">
        <TabsTrigger
          ref={refFor("description")}
          variant="underline"
          value="description"
          className="pb-3 data-[state=active]:border-transparent"
        >
          Description
        </TabsTrigger>
        <TabsTrigger
          ref={refFor("changes")}
          variant="underline"
          value="changes"
          className="pb-3 data-[state=active]:border-transparent"
        >
          Changes{fileCount !== undefined ? ` ${fileCount}` : ""}
        </TabsTrigger>
        <TabsTrigger
          ref={refFor("checks")}
          variant="underline"
          value="checks"
          className="pb-3 data-[state=active]:border-transparent"
        >
          Checks
        </TabsTrigger>
        {indicator && (
          <div
            aria-hidden
            className="pointer-events-none absolute bottom-[-1px] h-0.5 bg-primary transition-[left,width] duration-200 ease-out"
            style={{ left: indicator.left, width: indicator.width }}
          />
        )}
      </TabsList>
      <TabsContent value="description" className="mt-6">
        <DescriptionTab
          pr={pr}
          connectionId={connectionId}
          owner={owner}
          repo={repo}
        />
      </TabsContent>
      <TabsContent value="changes" className="mt-6">
        <ChangesTab
          pr={pr}
          connectionId={connectionId}
          owner={owner}
          repo={repo}
        />
      </TabsContent>
      <TabsContent value="checks" className="mt-6">
        <ChecksTab
          pr={pr}
          connectionId={connectionId}
          owner={owner}
          repo={repo}
        />
      </TabsContent>
    </Tabs>
  );
}
