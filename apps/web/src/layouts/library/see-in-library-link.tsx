/**
 * "See in library" — opens the Library panel in the chat view, with the
 * file's folder navigated to and the file itself opened in preview.
 * Shown only when a file is previewed away from the Library (over a chat
 * conversation).
 */

import { Button } from "@decocms/ui/components/button.tsx";
import { Folder } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { useT } from "@/i18n/use-t.ts";

export function SeeInLibraryLink({ previewPath }: { previewPath: string }) {
  const t = useT();
  const navigate = useNavigate();
  const parentPath = previewPath.split("/").slice(0, -1).join("/");

  const handleClick = () => {
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        // The Library is the `files` main-panel tab; `path` is what navigates
        // it. (This used to set a `library:<path>` tab id that no parser knew,
        // so the button did nothing.)
        main: "files",
        path: parentPath || undefined,
        preview: previewPath,
        skill: undefined,
        brand: undefined,
      }),
    });
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleClick}
      className="shrink-0 gap-1.5 text-xs text-muted-foreground"
    >
      <Folder size={14} />
      {t("library.seeInLibrary.label")}
    </Button>
  );
}
