import { useState } from "react";
import { LibraryPage } from "@/layouts/library";
import { LibraryPreviewDialog } from "@/layouts/library/preview-dialog";
import { SkillPreviewDialog } from "@/layouts/library/skill-preview";
import { BrandPreviewDialog } from "@/layouts/library/brand-preview";
import { formatLibraryFileTabId } from "./tab-id";
import { usePanelNavigate } from "./use-panel-navigate";

export function LibraryTab({
  root,
  rootLabel,
  filePreview = "panel",
}: {
  /** Top of the tree — one project's folder, or the org's drive by default. */
  root?: string;
  rootLabel?: string;
  /**
   * How a clicked file opens.
   *
   * `panel` hands it to the main-panel tab system, which is only correct on a
   * surface that HAS one. The flat project screen does not: opening a tab from
   * there swapped the whole shell for the scoped one — a sidebar that jumped
   * into the project and a breadcrumb naming the agent instead of the file's
   * project. `dialog` previews the file in place, over the files it came from.
   */
  filePreview?: "panel" | "dialog";
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
        onOpenFile={
          filePreview === "dialog"
            ? setOpenFile
            : (path) => openPanel(formatLibraryFileTabId(path))
        }
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
