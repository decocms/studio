import { useEffect, useEffectEvent } from "react";
import { useDebouncedSaveBlock } from "@/components/sections-editor/use-save-block";
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
  const { save, flush } = useDebouncedSaveBlock({
    orgSlug,
    virtualMcpId,
    branch,
  });
  // Saves what's pending when the editor goes away (the debounce alone
  // would drop it): runs after the save hook's own timer cleanup.
  const flushPending = useEffectEvent(() => flush());
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- flush pending autosaves on unmount
  useEffect(() => () => flushPending(), []);
  return (
    <SchemalessContent
      decofile={decofile}
      onChange={(blockKey, next) => save(blockKey, next)}
      onLeaveBlock={flush}
      initialKey={initialKey}
      compact={compact}
    />
  );
}
