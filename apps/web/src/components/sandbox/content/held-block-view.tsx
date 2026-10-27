import { Fragment, type ReactNode, useState } from "react";
import { Trash01 } from "@untitledui/icons";
import {
  copyScope,
  useCopyEpochs,
} from "@/components/sections-editor/held-copy";
import { useContentBackend } from "@/components/sections-editor/use-content-backend";
import { useT } from "@/i18n/use-t.ts";
import { EmptyMessage } from "./empty-message";
import { useNeverPublished } from "@/components/sections-editor/use-never-published";

/**
 * An editor that keeps its own copy of `blockKey` (its save hook has
 * `holdsCopy`), shown as a hosted v8 draft holds the block: remounted from
 * the draft's copy when a reconcile replaced it (their version, a merge),
 * and a calm "deleted" state in place of the form once the draft no longer
 * has the block, so no keystroke brings it back unasked. Another block (a
 * move renamed it) is the editor's own business: no remount. Other
 * backends render the editor as before.
 */
export function HeldBlockView({
  orgSlug,
  virtualMcpId,
  branch,
  blockKey,
  present,
  showDeleted = true,
  children,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  blockKey: string;
  /** Whether the draft (the editor's blocks) has the block; undefined: unknown. */
  present: boolean | undefined;
  /** False for an editor that shows a missing block itself. */
  showDeleted?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const backend = useContentBackend(virtualMcpId, branch);
  const hosted = backend.kind === "protocol" && backend.source === "github";
  const epochOf = useCopyEpochs(copyScope({ orgSlug, virtualMcpId, branch }));
  // Never published: Publish lists no deletion of it to discard.
  const neverPublished = useNeverPublished({ orgSlug, virtualMcpId, branch });
  const epoch = hosted ? epochOf(blockKey) : 0;
  // How many times the shown block's copy was replaced while shown: the
  // form's key.
  const [shown, setShown] = useState({ blockKey, epoch, remounts: 0 });
  const replaced = shown.blockKey === blockKey && shown.epoch !== epoch;
  const remounts = shown.remounts + (replaced ? 1 : 0);
  if (shown.blockKey !== blockKey || shown.epoch !== epoch) {
    setShown({ blockKey, epoch, remounts });
  }
  if (hosted && showDeleted && present === false) {
    return (
      <EmptyMessage
        icon={Trash01}
        title={t("sectionsEditor.reconcile.deletedTitle")}
        description={t(
          neverPublished(blockKey)
            ? "sectionsEditor.reconcile.deletedNeverPublishedDescription"
            : "sectionsEditor.reconcile.deletedDescription",
        )}
      />
    );
  }
  return <Fragment key={remounts}>{children}</Fragment>;
}
