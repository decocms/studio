import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { LibraryPage } from "@/layouts/library";
import { SkillPreviewDialog } from "@/layouts/library/skill-preview";
import { BrandPreviewDialog } from "@/layouts/library/brand-preview";
import { formatLibraryFileTabId } from "./tab-id";

export function LibraryTab() {
  const navigate = useNavigate();
  const [openSkill, setOpenSkill] = useState<string | null>(null);
  const [openBrand, setOpenBrand] = useState<string | null>(null);

  const openAsTab = (tabId: string) =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, main: tabId }),
      replace: true,
    });

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <LibraryPage
        onOpenFile={(path) => openAsTab(formatLibraryFileTabId(path))}
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
