/**
 * "See in library" — opens the Library panel in the chat view, with the
 * file's folder navigated to and the file itself opened in preview.
 * Shown only when a file is previewed away from the Library (over a chat
 * conversation).
 */

import { Button } from "@deco/ui/components/button.tsx";
import { Folder } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";

export function SeeInLibraryLink({ previewPath }: { previewPath: string }) {
  const navigate = useNavigate();
  const parentPath = previewPath.split("/").slice(0, -1).join("/");

  const handleClick = () => {
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        main: `library:${parentPath}`,
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
      See in library
    </Button>
  );
}
