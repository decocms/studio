/**
 * Shell-level controls shared between the main org shell and the settings
 * shell. Both render `Toolbar.Header` on top, a sidebar below on the left,
 * and a mobile sheet for the sidebar on small screens.
 */

import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetTitle } from "@deco/ui/components/sheet.tsx";
import { useSidebar } from "@deco/ui/components/sidebar.tsx";
import { LayoutLeft } from "@untitledui/icons";
import { ToolbarIconButton } from "@/web/components/toolbar-icon-button";
import { useT } from "@/web/i18n/use-t.ts";

export function SidebarTriggerButton({ className }: { className?: string }) {
  const t = useT();
  const { toggleSidebar } = useSidebar();
  return (
    <ToolbarIconButton
      onClick={toggleSidebar}
      aria-label={t("layouts.shellControls.toggleSidebar")}
      className={className}
    >
      <LayoutLeft size={16} />
    </ToolbarIconButton>
  );
}

interface MobileSidebarSheetProps {
  renderSidebar: (props: { onClose: () => void }) => ReactNode;
}

export function MobileSidebarSheet({ renderSidebar }: MobileSidebarSheetProps) {
  const t = useT();
  const { openMobile, setOpenMobile } = useSidebar();
  return (
    <Sheet open={openMobile} onOpenChange={setOpenMobile}>
      <SheetContent
        side="left"
        hideCloseButton
        className="w-screen max-w-none! p-0"
      >
        <SheetTitle className="sr-only">
          {t("layouts.shellControls.navigationTitle")}
        </SheetTitle>
        {renderSidebar({ onClose: () => setOpenMobile(false) })}
      </SheetContent>
    </Sheet>
  );
}
