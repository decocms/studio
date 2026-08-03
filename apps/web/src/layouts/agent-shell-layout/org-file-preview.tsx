/**
 * Mobile-only Library file-preview overlay over the chat when `?preview=<browse
 * path>` is set — the param a clickable org-file reference in an agent message
 * navigates to on mobile (see chat/markdown.tsx). Desktop opens the file as a
 * main-panel side tab instead (`?main=library-file:<path>`), mirroring the
 * Library's own panel/dialog split. Reuses the Library's URL-driven dialog so
 * the preview survives reload and closing returns to the conversation.
 */

import { useNavigate, useSearch } from "@tanstack/react-router";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { LibraryPreviewDialog } from "@/layouts/library/preview-dialog";
import { useChatTask } from "@/components/chat/context";

export function OrgFilePreviewMount() {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const { preview } = useSearch({ strict: false }) as { preview?: string };
  const { canMutateThread } = useChatTask();

  if (!isMobile || !preview) return null;

  return (
    <LibraryPreviewDialog
      previewPath={preview}
      onClose={() =>
        navigate({
          to: ".",
          search: (prev: Record<string, unknown>) => {
            const { preview: _omit, ...rest } = prev;
            return rest;
          },
        })
      }
      showSeeInLibrary
      readOnly={!canMutateThread}
    />
  );
}
