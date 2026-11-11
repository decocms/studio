import { CmsBlockBoundary } from "@/cms/block-boundary";
import { useEffect, useEffectEvent } from "react";
import { useDebouncedSaveBlock } from "@/components/sections-editor/use-save-block";
import {
  copyScope,
  useCopyEpochs,
} from "@/components/sections-editor/held-copy";
import { cmsSiteOf } from "@/cms/cms-api";
import { useVirtualMCP } from "@/sdk";
import { SchemalessContent } from "./schemaless-content";

/**
 * `SchemalessContent` wired to the editor's autosave (debounced, one
 * `blocks.apply` per block). Pending edits are saved on leaving a block and
 * when this unmounts, which is what happens the moment the schema appears
 * and the regular editor takes over.
 */
export function SchemalessEditor({
  orgSlug,
  virtualMcpId,
  branch,
  decofile,
  initialKey,
  compact,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown>;
  initialKey?: string | null;
  compact?: boolean;
}) {
  // The Studio site the banner's agent prompt names (`DECO_SITE`).
  const site = cmsSiteOf(useVirtualMCP(virtualMcpId)?.metadata);
  // Each block's form keeps its own copy: hosted saves are guarded by it.
  const { save, flush, hold } = useDebouncedSaveBlock(
    { orgSlug, virtualMcpId, branch },
    { holdsCopy: true },
  );
  const copyEpochOf = useCopyEpochs(
    copyScope({ orgSlug, virtualMcpId, branch }),
  );
  // Saves what's pending when the editor goes away (the debounce alone
  // would drop it): runs after the save hook's own timer cleanup.
  const flushPending = useEffectEvent(() => flush());
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- flush pending autosaves on unmount
  useEffect(() => () => flushPending(), []);
  return (
    <SchemalessContent
      decofile={decofile}
      site={site}
      onChange={(blockKey, next) => save(blockKey, next)}
      onLeaveBlock={flush}
      onOpenBlock={hold}
      wrapEditor={(blockKey, editor) => (
        <CmsBlockBoundary
          listing={decofile}
          scope={{ orgSlug, virtualMcpId, branch }}
          names={[blockKey]}
        >
          {editor}
        </CmsBlockBoundary>
      )}
      copyEpochOf={copyEpochOf}
      initialKey={initialKey}
      compact={compact}
    />
  );
}
