/**
 * LibraryFileTab — main-panel side preview of an org Library file referenced
 * from a chat message (`?main=library-file:<encoded browse path>`).
 *
 * Thin adapter over the shared LibraryPreviewPanel — the SAME side panel the
 * desktop Library uses — with the "See in library" jump enabled since the
 * preview is opened away from the Library itself. On mobile the chat opens the
 * dialog form (OrgFilePreviewMount) instead, mirroring the Library's split.
 */

import { useNavigate } from "@tanstack/react-router";
import { LibraryPreviewPanel } from "@/layouts/library/preview-panel";

export function LibraryFileTab({
  path,
  readOnly,
}: {
  path: string;
  readOnly: boolean;
}) {
  const navigate = useNavigate();
  const onClose = () =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        main: 0 as const,
      }),
      replace: true,
    });
  return (
    <LibraryPreviewPanel
      previewPath={path}
      onClose={onClose}
      showSeeInLibrary
      readOnly={readOnly}
    />
  );
}
