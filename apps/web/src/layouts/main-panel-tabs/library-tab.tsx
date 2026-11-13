import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { LibraryPage } from "@/layouts/library";
import { LibraryPreviewDialog } from "@/layouts/library/preview-dialog";
import { SkillPreviewDialog } from "@/layouts/library/skill-preview";
import { BrandPreviewDialog } from "@/layouts/library/brand-preview";

type FilePreviewMode = "dialog" | "side";

export function LibraryTab({
  root,
  rootLabel,
  filePreview,
}: {
  /** Top of the tree — one project's folder, or the org's drive by default. */
  root?: string;
  rootLabel?: string;
  /**
   * Where `?preview=` opens. `dialog` previews the file in place, over the
   * files it came from. `side` leaves it to the Library, which opens it beside
   * the list.
   */
  filePreview: FilePreviewMode;
}) {
  const navigate = useNavigate();
  const { preview } = useSearch({ strict: false }) as { preview?: string };
  const [openSkill, setOpenSkill] = useState<string | null>(null);
  const [openBrand, setOpenBrand] = useState<string | null>(null);
  const setPreview = (path: string | undefined) =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, preview: path }),
    });

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <LibraryPage
        root={root}
        rootLabel={rootLabel}
        onOpenFile={filePreview === "dialog" ? setPreview : undefined}
        onOpenSkill={setOpenSkill}
        onOpenBrand={setOpenBrand}
      />
      {filePreview === "dialog" && preview && (
        <LibraryPreviewDialog
          key={preview}
          previewPath={preview}
          onClose={() => setPreview(undefined)}
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
