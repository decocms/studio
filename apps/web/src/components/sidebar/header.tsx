import { LayoutLeft } from "@untitledui/icons";
import { useSidebar } from "@decocms/ui/components/sidebar.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { SidebarThreadButton } from "./thread-button";

import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";
import { useProjectFirstNav } from "@/hooks/use-preferences";
import { useT } from "@/i18n/use-t.ts";
import { OrgProjectPicker } from "./org-project-picker";
import { ProjectSwitcher } from "./project-switcher";

const ICON_SIZE = 16;

/** Project-first navigation names the org or the open project here; classic keeps the picker. */
export function SidebarPickerHeader() {
  const collapsed = useSidebarCollapsed();
  const projectFirstNav = useProjectFirstNav();

  if (projectFirstNav) {
    return (
      <>
        <ProjectSwitcher collapsed={collapsed} />
        <CollapseToggle />
        <SidebarThreadButton />
      </>
    );
  }

  return (
    <>
      <OrgProjectPicker collapsed={collapsed} />
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
  const projectFirstNav = useProjectFirstNav();

  return (
    <>
      {/* Picking closes the sheet, or the thing you just chose stays hidden
          behind it. */}
      {/* The switcher grows to fill the row itself; the classic picker does not. */}
      {projectFirstNav ? (
        <ProjectSwitcher onNavigate={onClose} />
      ) : (
        <>
          <OrgProjectPicker onNavigate={onClose} />
          <div className="flex-1" />
        </>
      )}
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

function CollapseToggle() {
  const t = useT();
  const collapsed = useSidebarCollapsed();
  const { toggleSidebar } = useSidebar();
  const label = t(collapsed ? "page.expandSidebar" : "page.collapseSidebar");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToolbarIconButton
          aria-label={label}
          onClick={toggleSidebar}
          className="shrink-0 group-data-[state=collapsed]/sidebar:mx-auto size-7 group-data-[state=collapsed]/sidebar:size-8"
        >
          <LayoutLeft size={ICON_SIZE} />
        </ToolbarIconButton>
      </TooltipTrigger>
      {/* Expanded, this sits next to a picker that already names the place, so
          a tooltip repeating the button is noise. */}
      <TooltipContent side="right" hidden={!collapsed}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
