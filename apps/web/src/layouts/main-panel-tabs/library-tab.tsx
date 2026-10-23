import { useState } from "react";
import { LibraryPage } from "@/layouts/library";
import { LibraryPreviewDialog } from "@/layouts/library/preview-dialog";
import { SkillPreviewDialog } from "@/layouts/library/skill-preview";
import { BrandPreviewDialog } from "@/layouts/library/brand-preview";
import { formatLibraryFileTabId } from "./tab-id";
import { usePanelNavigate } from "./use-panel-navigate";

type FilePreviewMode = "panel" | "dialog" | "side";

/** What a click on a file does; `undefined` lets the Library decide. */
function fileOpener(
  mode: FilePreviewMode,
  openDialog: (path: string) => void,
  openTab: (path: string) => void,
): ((path: string) => void) | undefined {
  switch (mode) {
    case "dialog":
      return openDialog;
    case "panel":
      return openTab;
    case "side":
      return undefined;
    default: {
      const unhandled: never = mode;
      return unhandled;
    }
  }
}

export function LibraryTab({
  root,
  rootLabel,
  filePreview = "panel",
  context,
}: {
  /** Top of the tree — one project's folder, or the org's drive by default. */
  root?: string;
  rootLabel?: string;
  /**
   * How a clicked file opens.
   *
   * `panel` hands it to the main-panel tab system, which is only correct on a
   * surface that HAS one. `dialog` previews the file in place, over the files
   * it came from.
   * `side` leaves it to the Library, which opens it beside the list.
   */
  filePreview?: FilePreviewMode;
  /** Drawn inside Context. */
  context?: boolean;
} = {}) {
  const { openPanel } = usePanelNavigate();
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [openSkill, setOpenSkill] = useState<string | null>(null);
  const [openBrand, setOpenBrand] = useState<string | null>(null);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <LibraryPage
        root={root}
        rootLabel={rootLabel}
        context={context}
        onOpenFile={fileOpener(filePreview, setOpenFile, (path) =>
          openPanel(formatLibraryFileTabId(path)),
        )}
        onOpenSkill={setOpenSkill}
        onOpenBrand={setOpenBrand}
      />
      {openFile && (
        <LibraryPreviewDialog
          key={openFile}
          previewPath={openFile}
          onClose={() => setOpenFile(null)}
        />
      )}
      {openSkill && (
        <SkillPreviewDialog
          key={openSkill}
          skillPath={openSkill}
          onClose={() => setOpenSkill(null)}
        />
      )}
      {openBrand && (
        <BrandPreviewDialog
          key={openBrand}
          brandPath={openBrand}
          onClose={() => setOpenBrand(null)}
        />
      )}
    </div>
  );
}
