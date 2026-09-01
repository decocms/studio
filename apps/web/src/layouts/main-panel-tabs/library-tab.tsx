import { useState } from "react";
import { LibraryPage } from "@/layouts/library";
import { SkillPreviewDialog } from "@/layouts/library/skill-preview";
import { BrandPreviewDialog } from "@/layouts/library/brand-preview";
import { formatLibraryFileTabId } from "./tab-id";
import { usePanelNavigate } from "./use-panel-navigate";

export function LibraryTab() {
  const { openPanel } = usePanelNavigate();
  const [openSkill, setOpenSkill] = useState<string | null>(null);
  const [openBrand, setOpenBrand] = useState<string | null>(null);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <LibraryPage
        onOpenFile={(path) => openPanel(formatLibraryFileTabId(path))}
        onOpenSkill={setOpenSkill}
        onOpenBrand={setOpenBrand}
      />
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
