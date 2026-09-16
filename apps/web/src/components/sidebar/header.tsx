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
import { useT } from "@/i18n/use-t.ts";
import { OrgProjectPicker } from "./org-project-picker";

const ICON_SIZE = 16;

export function SidebarPickerHeader() {
  const collapsed = useSidebarCollapsed();

  return (
    <>
      <OrgProjectPicker collapsed={collapsed} />
      <CollapseToggle />
      <SidebarThreadButton />
    </>
  );
}

/** The same strip for the mobile sheet: the SAME picker, and a close button
 *  where the desktop keeps its collapse toggle — a sheet closes, it does not
 *  collapse. Every sheet gets it, settings included: the picker is how you
 *  change org or project, and a settings tree without it was a sheet you could
 *  neither switch from nor dismiss.
 *
 *  ONE selector, deliberately. This strip used to carry an agent switcher
 *  beside the picker, which read as two competing scopes over one entity —
 *  agents and projects are both virtual MCPs, so the picker's project rows and
 *  the agent list were the same things under two names. */
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
      <OrgProjectPicker onNavigate={onClose} />
      <div className="flex-1" />
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
          className="size-7 shrink-0 group-data-[state=collapsed]/sidebar:mx-auto group-data-[state=collapsed]/sidebar:size-8"
        >
          <LayoutLeft size={ICON_SIZE} />
        </ToolbarIconButton>
      </TooltipTrigger>
      {/* Expanded, this sits next to a picker that already names the place, so
          a tooltip repeating the button is noise. The rail is where it earns
          its keep, and it is shown there only. */}
      <TooltipContent side="right" hidden={!collapsed}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
