/**
 * LibraryFileTab — main-panel side preview of an org Library file referenced
 * from a chat message (`/agents/{-$project}/library-file?path=…`).
 *
 * Thin adapter over the shared LibraryPreviewPanel — the SAME side panel the
 * desktop Library uses — with the "See in library" jump enabled since the
 * preview is opened away from the Library itself. On mobile the chat opens the
 * dialog form (OrgFilePreviewMount) instead, mirroring the Library's split.
 */

import { LibraryPreviewPanel } from "@/layouts/library/preview-panel";
import { usePanelNavigate } from "./use-panel-navigate";

export function LibraryFileTab({ path }: { path: string }) {
  const { closePanel } = usePanelNavigate();
  const onClose = () => closePanel();
  return (
    <LibraryPreviewPanel
      previewPath={path}
      onClose={onClose}
      showSeeInLibrary
    />
  );
}
