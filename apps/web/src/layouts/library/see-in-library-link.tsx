/**
 * "See in library" — jumps to a file's folder in the Library page, with the
 * file itself opened in preview. Shown only when a file is previewed away
 * from the Library (over a chat conversation: the mobile dialog and the
 * desktop main-panel tab). Shared by preview-dialog and preview-panel.
 */

import { Button } from "@deco/ui/components/button.tsx";
import { Folder } from "@untitledui/icons";
import { Link } from "@tanstack/react-router";

export function SeeInLibraryLink({
  org,
  previewPath,
}: {
  org: string;
  previewPath: string;
}) {
  const parentPath = previewPath.split("/").slice(0, -1).join("/");
  return (
    <Button
      variant="ghost"
      size="sm"
      asChild
      className="shrink-0 gap-1.5 text-xs text-muted-foreground"
    >
      <Link
        to="/$org/files"
        params={{ org }}
        search={{ path: parentPath, preview: previewPath }}
      >
        <Folder size={14} />
        See in library
      </Link>
    </Button>
  );
}
