import { LayoutLeft } from "@untitledui/icons";
import { useSidebar } from "@decocms/ui/components/sidebar.tsx";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { SidebarThreadButton } from "./thread-button";
import { useT } from "@/i18n/use-t.ts";
import { ProjectSwitcher } from "./project-switcher";

const ICON_SIZE = 16;

/** Names the org or the open project. */
export function SidebarPickerHeader() {
  return (
    <>
      <ProjectSwitcher />
      <CollapseToggle />
      <SidebarThreadButton />
    </>
  );
}

/** The same strip for the mobile sheet, with a close button where the desktop
 *  keeps its collapse toggle — a sheet closes, it does not collapse. */
export function SidebarPickerHeaderMobile({
  onClose,
}: {
  onClose: () => void;
}) {
  const t = useT();

  return (
    <>
      {/* Picking closes the sheet, or the thing you just chose stays hidden
          behind it. */}
      <ProjectSwitcher onNavigate={onClose} />
      <SidebarThreadButton />
      <ToolbarIconButton
        onClick={onClose}
        aria-label={t("sidebar.header.closeSidebar")}
      >
        <LayoutLeft size={ICON_SIZE} />
      </ToolbarIconButton>
    </>
  );
}

/** No tooltip: it sits next to a picker that already names the place. The
 *  collapsed sidebar has zero width, so reopening is the page header's toggle. */
function CollapseToggle() {
  const t = useT();
  const { toggleSidebar } = useSidebar();

  return (
    <ToolbarIconButton
      aria-label={t("page.collapseSidebar")}
      onClick={toggleSidebar}
      className="shrink-0 size-7"
    >
      <LayoutLeft size={ICON_SIZE} />
    </ToolbarIconButton>
  );
}
