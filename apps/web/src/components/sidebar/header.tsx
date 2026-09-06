/** The header strip both desktop sidebars carry: the org/project picker, then
 *  the collapse toggle. The picker took the org switcher's slot, so the one
 *  control naming both org and project sits where people already look for the
 *  org — and settings reads as the same product rather than a place you were
 *  teleported to. Collapsed, the shell stacks these two into the rail and the
 *  picker becomes its own mark: the rail is this header with the text dropped,
 *  never a second header rebuilt inside the body. */

import { LayoutLeft } from "@untitledui/icons";
import { useSidebar } from "@decocms/ui/components/sidebar.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";
import { useT } from "@/i18n/use-t.ts";
import { OrgProjectPicker } from "./org-project-picker";

export function SidebarPickerHeader() {
  const collapsed = useSidebarCollapsed();

  return (
    <>
      <OrgProjectPicker collapsed={collapsed} />
      <CollapseToggle collapsed={collapsed} />
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
      <ToolbarIconButton
        onClick={onClose}
        aria-label={t("sidebar.header.closeSidebar")}
      >
        <LayoutLeft size={16} />
      </ToolbarIconButton>
    </>
  );
}

/** Deliberately not `SidebarTriggerButton`: the rail needs a tooltip on this,
 *  and a tooltip needs a ref that the shared toolbar control does not
 *  forward. */
function CollapseToggle({ collapsed }: { collapsed: boolean }) {
  const t = useT();
  const { toggleSidebar } = useSidebar();
  const label = t("sidebar.header.toggleSidebar");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToolbarIconButton
          aria-label={label}
          onClick={toggleSidebar}
          className="shrink-0 rounded-lg md:size-[34px] group-data-[state=collapsed]/sidebar:mx-auto"
        >
          <LayoutLeft size={16} />
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
