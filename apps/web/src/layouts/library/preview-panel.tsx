/**
 * Library file preview panel — right-side panel over the shared
 * LibraryFilePreview body, mirroring the chat's file tab (toolbar + preview).
 * Used by the desktop Library and the chat org-file side tab. URL-driven so a
 * preview link survives reload: the entry is re-resolved via `stat`, not read
 * off list caches. The mobile/overlay surface is preview-dialog.tsx.
 *
 * HTML files render the shared HtmlPreviewPanel — the SAME single toolbar the
 * chat deck tab shows — with the close action appended; only home-volume files
 * are writable (the inline editor persists to the home volume).
 */

import {
  LibraryFilePreview,
  type LibraryPreviewProps,
} from "./preview-content";

export function LibraryPreviewPanel({
  previewPath,
  onClose,
  showSeeInLibrary = false,
  readOnly = false,
}: LibraryPreviewProps) {
  return (
    <div className="flex h-full w-full flex-col bg-background">
      <LibraryFilePreview
        previewPath={previewPath}
        onClose={onClose}
        showSeeInLibrary={showSeeInLibrary}
        readOnly={readOnly}
        variant="panel"
      />
    </div>
  );
}
