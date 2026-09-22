import { useCompactPageLayout } from "@/hooks/use-preferences";
import { SidebarTrigger } from "@decocms/ui/components/sidebar.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { Panel } from "@/components/panel";
import { Page } from "@/components/page";

/** Detail views contribute to the surrounding page instead of nesting a second header. */
function CompactDetailPanel({
  children,
  leading,
}: {
  children: ReactNode;
  leading?: ReactNode;
}) {
  return (
    <Page>
      {leading && (
        <Panel.Toolbar.Left.Portal fallback={leading}>
          {leading}
        </Panel.Toolbar.Left.Portal>
      )}
      <Page.Content>{children}</Page.Content>
    </Page>
  );
}

function ClassicDetailPanel({
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

export function DetailPanel(props: {
  children: ReactNode;
  leading?: ReactNode;
  hideTopbar?: boolean;
}) {
  const compact = useCompactPageLayout();
  return compact ? (
    <CompactDetailPanel {...props} />
  ) : (
    <ClassicDetailPanel {...props} />
  );
}
