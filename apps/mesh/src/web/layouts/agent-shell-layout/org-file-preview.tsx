/**
 * Renders the Library file-preview overlay over the chat when `?preview=<browse
 * path>` is set — the param a clickable org-file reference in an agent message
 * navigates to (see chat/markdown.tsx). Reuses the Library's URL-driven dialog
 * so the preview survives reload and closing returns to the conversation.
 */

import { useNavigate, useSearch } from "@tanstack/react-router";
import { LibraryPreviewDialog } from "@/web/layouts/library/preview-dialog";

export function OrgFilePreviewMount() {
  const navigate = useNavigate();
  const { preview } = useSearch({ strict: false }) as { preview?: string };

  if (!preview) return null;

  return (
    <LibraryPreviewDialog
      previewPath={preview}
      showSeeInLibrary
      onClose={() =>
        navigate({
          to: ".",
          search: (prev: Record<string, unknown>) => {
            const { preview: _omit, ...rest } = prev;
            return rest;
          },
        })
      }
    />
  );
}
