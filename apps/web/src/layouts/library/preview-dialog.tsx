/**
 * Library file preview — near-fullscreen dialog over the shared
 * LibraryFilePreview body (mobile chat overlay / shared `?preview=` links).
 * URL-driven so a preview link survives reload: the entry is re-resolved via
 * `stat`, not read off list caches. The desktop surface is preview-panel.tsx.
 */

import { Dialog, DialogContent } from "@deco/ui/components/dialog.tsx";
import {
  LibraryFilePreview,
  type LibraryPreviewProps,
} from "./preview-content";

export function LibraryPreviewDialog({
  previewPath,
  onClose,
}: LibraryPreviewProps) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex h-[88vh] w-[94vw] max-w-none! flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl!">
        <LibraryFilePreview
          previewPath={previewPath}
          onClose={onClose}
          variant="dialog"
        />
      </DialogContent>
    </Dialog>
  );
}
