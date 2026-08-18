import { useState, type ReactNode } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { ScrollFade } from "./scroll-fade";
import { Edit05, LayoutLeft, SearchSm } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@decocms/ui/components/sidebar.tsx";
import { useProjectContext } from "@/sdk";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { SidebarTriggerButton } from "@/layouts/shell-controls";
import { OrgIcon, OrgSwitcherPopover } from "@/components/header/org-switcher";
import { ThreadFiltersPopover } from "./thread-filters-popover";
import { ThreadsPanelList, useThreadsPanel } from "./use-threads-panel";

/** Toolbar icon button with the shared dark tooltip (matches the collapsed
 * rail's SidebarMenuButton tooltip). `active` gives the pressed/highlighted look.
 *
 * Open state is driven purely by hover/focus (not Radix's defaults) so a click
 * doesn't dismiss the tooltip while the pointer is still over the button. */
function ToolbarTooltipButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open}>
      <TooltipTrigger asChild>
        <ToolbarIconButton
          aria-label={label}
          onClick={onClick}
          onPointerEnter={() => setOpen(true)}
          onPointerLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          className={cn(
            "md:size-[34px] rounded-lg",
            active && "bg-sidebar-accent text-foreground",
          )}
        >
          {children}
        </ToolbarIconButton>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function TaskGroupsList({
  onNavigate,
}: {
  onNavigate?: () => void;
} = {}) {
  const t = useT();
  const { org } = useProjectContext();
  const panel = useThreadsPanel({ onNavigate });

  const { state: sidebarState, isMobile, toggleSidebar } = useSidebar();

  const isCollapsed = sidebarState === "collapsed" && !isMobile;

  /**
   * Collapsed rail: the toggle up top, then a search button so threads stay
   * reachable without expanding.
   *
   * The rail is pinned to the collapsed icon width (var(--sidebar-width-icon) -
   * px-2) so its icons don't reflow while the sidebar animates its width down on
   * collapse: without the pin they'd render centered in the still-wide sidebar,
   * then slide left as it shrinks — that horizontal drift is the "flick".
   */
  if (isCollapsed) {
    return (
      <div className="flex flex-col min-h-0 flex-1 -mt-1 w-[calc(var(--sidebar-width-icon)-1rem)]">
        {/* Mirror the OPEN sidebar's top exactly so nothing jumps when toggling:
            the org sits in an h-12 slot (= the open header's height) pulled flush
            to the top via -mt-1 (cancels the collapsed additionalContent margin),
            then an mt-2 before the menu reproduces the open header→toolbar gap so
            the collapse toggle lands at the same height as its open counterpart. */}
        <div className="flex h-12 shrink-0 items-center justify-center">
          <OrgSwitcherPopover
            orgParam={org.slug}
            side="right"
            align="start"
            trigger={
              <SidebarMenuButton tooltip={org.name}>
                <OrgIcon org={org} size="sm" />
              </SidebarMenuButton>
            }
          />
        </div>
        <SidebarMenu className="mt-2 min-h-0 gap-1.5 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <SidebarMenuItem>
            <SidebarMenuButton
              aria-label={t("sidebar.taskGroupsList.toggleSidebar")}
              tooltip={t("sidebar.taskGroupsList.toggleSidebar")}
              onClick={toggleSidebar}
            >
              <LayoutLeft size={16} />
            </SidebarMenuButton>
          </SidebarMenuItem>
          {/* New chat lives in the panel header when the sidebar is collapsed
              (see workspace-panel-group), so it's intentionally omitted from the
              collapsed rail to avoid duplicating it. */}
          <SidebarMenuItem>
            <SidebarMenuButton
              aria-label={t("sidebar.taskGroupsList.searchChats")}
              tooltip={t("sidebar.taskGroupsList.searchChats")}
              onClick={panel.openSearch}
            >
              <SearchSm size={16} />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {panel.searchDialog}
        {panel.reclaimDialog}
      </div>
    );
  }

  const toolbar = (mobile: boolean) => (
    <TooltipProvider delayDuration={300}>
      <div
        className={cn(
          "shrink-0 flex items-center justify-between",
          mobile ? "h-10" : "h-10 md:h-[34px] mb-2",
        )}
      >
        {/* Left: sidebar trigger + filter popover. */}
        <div className="flex items-center gap-0.5">
          {!mobile && (
            <SidebarTriggerButton className="md:size-[34px] rounded-lg" />
          )}
          <ThreadFiltersPopover panel={panel} />
        </div>
        {/* Right: search + new thread. */}
        <div className="flex items-center gap-0.5">
          <ToolbarTooltipButton
            label={t("sidebar.taskGroupsList.searchChats")}
            onClick={panel.openSearch}
          >
            <SearchSm size={16} />
          </ToolbarTooltipButton>
          <ToolbarTooltipButton
            label={t("sidebar.taskGroupsList.newChat")}
            onClick={panel.newThread}
          >
            <Edit05 size={16} />
          </ToolbarTooltipButton>
        </div>
      </div>
    </TooltipProvider>
  );

  const list = <ThreadsPanelList panel={panel} />;

  if (isMobile) {
    return (
      <div className="flex flex-col h-full min-h-0">
        {toolbar(true)}
        <ScrollFade
          wrapperClassName="flex-1 min-h-0"
          className="flex flex-col gap-0.5 overflow-y-auto overscroll-contain px-1 h-full"
        >
          {list}
        </ScrollFade>
        {panel.searchDialog}
        {panel.reclaimDialog}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {toolbar(false)}
      <div className="flex-1 min-h-0 flex flex-col gap-0.5 -mr-2 pr-2">
        <ScrollFade
          wrapperClassName="flex-1 min-h-0"
          className="flex flex-col gap-0.5 overflow-y-auto overscroll-contain h-full"
        >
          {list}
        </ScrollFade>
      </div>
      {panel.searchDialog}
      {panel.reclaimDialog}
    </div>
  );
}
