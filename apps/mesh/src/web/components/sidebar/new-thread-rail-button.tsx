/**
 * NewThreadRailButton — the top action on the collapsed sidebar rail.
 *
 * Replaces the old "Browse agents" affordance there: agents are picked in the
 * toolbar breadcrumb now, so the rail's primary action is starting a new thread
 * (with the current agent scope / Decopilot).
 */
import {
  SidebarMenuButton,
  SidebarMenuItem,
} from "@deco/ui/components/sidebar.tsx";
import { Edit05 } from "@untitledui/icons";
import { usePanelActions } from "@/web/layouts/shell-layout";
import { track } from "@/web/lib/posthog-client";

export function NewThreadRailButton() {
  const { createNewTask } = usePanelActions();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip="New thread"
        onClick={() => {
          track("sidebar_new_thread_clicked", { source: "collapsed_rail" });
          void createNewTask();
        }}
      >
        <Edit05 />
        <span>New thread</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
