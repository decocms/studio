/**
 * "See in library" — opens the Library panel in the chat view, with the
 * file's folder navigated to and the file itself opened in preview.
 * Shown only when a file is previewed away from the Library (over a chat
 * conversation).
 */

import { Button } from "@decocms/ui/components/button.tsx";
import { Folder } from "@untitledui/icons";
import { useNavigate, useParams } from "@tanstack/react-router";
import { DESTINATION_ROUTE } from "@/hooks/use-destination-route";
import { useT } from "@/i18n/use-t.ts";

export function SeeInLibraryLink({ previewPath }: { previewPath: string }) {
  const t = useT();
  const navigate = useNavigate();
  const org = useParams({ strict: false }).org ?? "";
  const parentPath = previewPath.split("/").slice(0, -1).join("/");

  const handleClick = () => {
    /** The Library is a destination, not a panel: `path` navigates its folder
     *  and `preview` opens the file in its own side panel. */
    navigate({
      to: DESTINATION_ROUTE.library,
      params: { org },
      search: {
        path: parentPath || undefined,
        preview: previewPath,
      },
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
