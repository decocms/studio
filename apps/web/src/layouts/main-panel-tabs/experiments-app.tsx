/**
 * A Blocks (v8) project's Experiments app: its A/B tests, edited in the draft
 * (`ExperimentsBlockTab`). The open test is the URL's `?test=`, so a link can
 * open one and Back closes it.
 */

import { useOpenTestSearch } from "@/components/experiments/use-open-test-search";
import { ExperimentsBlockTab } from "./experiments-block-tab";

export function ExperimentsApp({ virtualMcpId }: { virtualMcpId: string }) {
  const open = useOpenTestSearch();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ExperimentsBlockTab virtualMcpId={virtualMcpId} open={open} />
    </div>
  );
}
