import type { ReactNode } from "react";
import { SidebarTrigger } from "@decocms/ui/components/sidebar.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Panel } from "@/components/panel";

/** Detail views supply their tabs and actions through the same Panel slots as routes. */
export function DetailPanel({
  children,
  leading,
  hideTopbar = false,
}: {
  children: ReactNode;
  leading?: ReactNode;
  hideTopbar?: boolean;
}) {
  return (
    <Panel variant="plain">
      <Panel.Topbar
        className={cn("h-11 border-b border-border/50", hideTopbar && "hidden")}
      >
        <Panel.Topbar.Left>
          <SidebarTrigger className="md:hidden shrink-0" />
          {leading}
        </Panel.Topbar.Left>
        <Panel.Topbar.Center>
          <Panel.Topbar.Center.Target />
        </Panel.Topbar.Center>
        <Panel.Topbar.Right>
          <Panel.Topbar.Right.Target />
        </Panel.Topbar.Right>
      </Panel.Topbar>
      <Panel.Content mode="scroll">{children}</Panel.Content>
    </Panel>
  );
}
