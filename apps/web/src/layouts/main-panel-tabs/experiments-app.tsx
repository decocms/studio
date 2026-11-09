/**
 * A Blocks (v8) project's Experiments app: its A/B tests, edited in the draft
 * (`ExperimentsBlockTab`), with what is live now under them (`ExperimentsLive`,
 * compact), so the published site sits next to the edits. The open test is the
 * URL's `?test=`, so a link can open one and Back closes it; a name the
 * draft doesn't have is dropped from the URL. A live test opens in the
 * editor only when the draft has it.
 */

import { ExperimentsLive } from "@/components/experiments/experiments-live";
import { useOpenTestSearch } from "@/components/experiments/use-open-test-search";
import { ExperimentsBlockTab } from "./experiments-block-tab";

export function ExperimentsApp({ virtualMcpId }: { virtualMcpId: string }) {
  const open = useOpenTestSearch();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ExperimentsBlockTab
        virtualMcpId={virtualMcpId}
        open={open}
        live={(ctx) => (
          <ExperimentsLive
            orgSlug={ctx.orgSlug}
            virtualMcpId={ctx.virtualMcpId}
            published={ctx.published}
            draft={ctx.draft}
            mode="compact"
            onOpen={(name) => name && ctx.openTest(name)}
          />
        )}
      />
    </div>
  );
}
