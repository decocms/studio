/** The composer's word that the agent will see the open Library file, and the
 *  way to leave it out of this question. */

import { XClose } from "@untitledui/icons";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import { FileTypeIcon } from "@/components/file-type-icon";
import { useOpenLibraryFile } from "@/hooks/use-open-library-file";
import { useT } from "@/i18n/use-t.ts";
import { basename } from "@/layouts/library/location";

export function OpenFileChip() {
  const t = useT();
  const openFile = useOpenLibraryFile();
  if (!openFile) return null;
  const name = basename(openFile.path);
  return (
    <div className="flex px-3 pt-3">
      <span
        className="surface-inset flex h-7 min-w-0 items-center gap-1.5 rounded-full pr-0.5 pl-2.5 text-xs text-foreground"
        title={t("chat.input.openFileContext", { name })}
      >
        <FileTypeIcon filename={name} className="h-4 w-3 shrink-0" />
        <span className="truncate">{name}</span>
        <IconButton
          label={t("chat.input.openFileDismiss")}
          size="icon-sm"
          onClick={openFile.dismiss}
        >
          <XClose size={12} />
        </IconButton>
      </span>
    </div>
  );
}
