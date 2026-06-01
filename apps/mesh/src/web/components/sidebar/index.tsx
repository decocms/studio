import { ErrorBoundary } from "@/web/components/error-boundary";
import { useProjectSidebarItems } from "@/web/hooks/use-project-sidebar-items";
import { Suspense } from "react";
import { Separator } from "@deco/ui/components/separator.tsx";
import { NavigationSidebar } from "./navigation";
import { MobileNavigationSidebar } from "./navigation-mobile";
import { SidebarInboxFooter } from "./footer/inbox";
import { SidebarInboxFooterMobile } from "./footer/inbox-mobile";
import { TaskGroupsList } from "./task-groups/task-groups-list";
import { TaskGroupsSkeleton } from "./task-groups/task-groups-skeleton";
import { SidebarAgentGroupsProvider } from "./sidebar-agent-groups-context";

export type {
  NavigationSidebarItem,
  SidebarSection,
  SidebarItemGroup,
  Invitation,
} from "./types";

export function StudioSidebar() {
  const sections = useProjectSidebarItems();

  return (
    <SidebarAgentGroupsProvider>
      <NavigationSidebar
        sections={sections}
        footer={<SidebarInboxFooter />}
        additionalContent={
          <ErrorBoundary>
            <Suspense
              fallback={
                <>
                  <Separator className="mb-2" />
                  <TaskGroupsSkeleton />
                </>
              }
            >
              <Separator className="mb-2" />
              <TaskGroupsList />
            </Suspense>
          </ErrorBoundary>
        }
      />
    </SidebarAgentGroupsProvider>
  );
}

export function StudioSidebarMobile({ onClose }: { onClose: () => void }) {
  const sections = useProjectSidebarItems();

  return (
    <SidebarAgentGroupsProvider>
      <MobileNavigationSidebar
        sections={sections}
        onClose={onClose}
        footer={<SidebarInboxFooterMobile />}
        additionalContent={
          <ErrorBoundary>
            <Suspense
              fallback={
                <>
                  <Separator className="mb-2" />
                  <TaskGroupsSkeleton />
                </>
              }
            >
              <Separator className="mb-2" />
              <TaskGroupsList />
            </Suspense>
          </ErrorBoundary>
        }
      />
    </SidebarAgentGroupsProvider>
  );
}
