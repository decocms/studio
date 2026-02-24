import { useDecoChatOpen } from "@/web/hooks/use-deco-chat-open";
import { Button } from "@deco/ui/components/button.tsx";
import {
  SidebarHeader as SidebarHeaderUI,
  SidebarMenu,
  SidebarMenuItem,
  useSidebar,
} from "@deco/ui/components/sidebar.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { MessageTextCircle02 } from "@untitledui/icons";
import { useParams, useRouterState } from "@tanstack/react-router";
import { MeshAccountSwitcher } from "./account-switcher";

interface MeshSidebarHeaderProps {
  onCreateProject?: () => void;
}

export function MeshSidebarHeader({ onCreateProject }: MeshSidebarHeaderProps) {
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isChatOpen, setChatOpen] = useDecoChatOpen();
  const { org, project } = useParams({ strict: false });
  const { location } = useRouterState();
  const isHomeRoute =
    location.pathname === `/${org}/${project}` ||
    location.pathname === `/${org}/${project}/`;

  const toggleChat = () => {
    setChatOpen((prev) => !prev);
  };

  return (
    <SidebarHeaderUI className="px-3 group-data-[collapsible=icon]:px-2 animate-in fade-in-0 duration-200">
      <SidebarMenu>
        <SidebarMenuItem>
          <div className="flex items-center justify-between w-full gap-1">
            <div className="min-w-0 flex-1">
              <MeshAccountSwitcher
                isCollapsed={isCollapsed}
                onCreateProject={onCreateProject}
              />
            </div>

            <div
              className={cn(
                "flex items-center gap-0.5 shrink-0 overflow-hidden transition-[max-width,opacity] duration-300 ease-[var(--ease-out-quart)]",
                isCollapsed || isHomeRoute
                  ? "max-w-0 opacity-0 pointer-events-none"
                  : "max-w-[2rem] opacity-100",
              )}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "size-7 hover:bg-sidebar-accent text-sidebar-foreground/50 hover:text-sidebar-foreground group-data-[studio]/sidebar-wrapper:text-sidebar-foreground/85",
                      isChatOpen && "bg-sidebar-accent text-sidebar-foreground",
                    )}
                    onClick={toggleChat}
                    aria-label="Toggle Decopilot"
                  >
                    <MessageTextCircle02 size={14} className="text-inherit" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Toggle Decopilot</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeaderUI>
  );
}

MeshSidebarHeader.Skeleton = function MeshSidebarHeaderSkeleton() {
  return (
    <SidebarHeaderUI className="px-3">
      <SidebarMenu>
        <SidebarMenuItem>
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-3 min-w-0 flex-1 p-1.5">
              <Skeleton className="size-8 rounded-md shrink-0 bg-sidebar-accent" />
              <Skeleton className="h-3.5 w-16 bg-sidebar-accent" />
            </div>
            <div className="flex items-center gap-0.5">
              <Skeleton className="size-7 rounded-lg bg-sidebar-accent" />
              <Skeleton className="size-7 rounded-lg bg-sidebar-accent" />
            </div>
          </div>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeaderUI>
  );
};
