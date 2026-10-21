import { useState } from "react";
import { LibraryPage } from "@/layouts/library";
import { LibraryPreviewDialog } from "@/layouts/library/preview-dialog";
import { SkillPreviewDialog } from "@/layouts/library/skill-preview";
import { BrandPreviewDialog } from "@/layouts/library/brand-preview";

type FilePreviewMode = "dialog" | "side";

export function LibraryTab({
  root,
  rootLabel,
  filePreview,
  context,
}: {
  /** Top of the tree — one project's folder, or the org's drive by default. */
  root?: string;
  rootLabel?: string;
  /**
   * How a clicked file opens. `dialog` previews the file in place, over the
   * files it came from. `side` leaves it to the Library, which opens it beside
   * the list.
   */
  filePreview: FilePreviewMode;
  /** Drawn inside Context. */
  context?: boolean;
}) {
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [openSkill, setOpenSkill] = useState<string | null>(null);
  const [openBrand, setOpenBrand] = useState<string | null>(null);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <LibraryPage
        root={root}
        rootLabel={rootLabel}
        context={context}
        onOpenFile={filePreview === "dialog" ? setOpenFile : undefined}
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
