import { Fragment, type ReactNode } from "react";
import { Trash01 } from "@untitledui/icons";
import {
  copyScope,
  useCopyEpochs,
} from "@/components/sections-editor/held-copy";
import { useContentBackend } from "@/components/sections-editor/use-content-backend";
import { useT } from "@/i18n/use-t.ts";
import { EmptyMessage } from "./empty-message";

/**
 * An editor that keeps its own copy of `blockKey` (its save hook has
 * `holdsCopy`), shown as a hosted v8 draft holds the block: remounted from
 * the draft's copy when a reconcile replaced it (their version, a merge),
 * and a calm "deleted" state in place of the form once the draft no longer
 * has the block, so no keystroke brings it back unasked. Other backends
 * render the editor as before.
 */
export function HeldBlockView({
  orgSlug,
  virtualMcpId,
  branch,
  blockKey,
  present,
  showDeleted = true,
  remount = true,
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
  /**
   * False for an editor that seeds its form again from the cache on its
   * own once edits settle (`useAutosave`): it needs no remount.
   */
  remount?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const backend = useContentBackend(virtualMcpId, branch);
  const hosted = backend.kind === "protocol" && backend.source === "github";
  const epochOf = useCopyEpochs(copyScope({ orgSlug, virtualMcpId, branch }));
  if (hosted && showDeleted && present === false) {
    return (
      <EmptyMessage
        icon={Trash01}
        title={t("sectionsEditor.reconcile.deletedTitle")}
        description={t("sectionsEditor.reconcile.deletedDescription")}
      />
    );
  }
  return (
    <Fragment key={hosted && remount ? epochOf(blockKey) : 0}>
      {children}
    </Fragment>
  );
}
