import { ErrorBoundary } from "@/web/components/error-boundary";
import { useProjectSidebarItems } from "@/web/hooks/use-project-sidebar-items";
import { Suspense } from "react";
import { NavigationSidebar } from "./navigation";
import { MobileNavigationSidebar } from "./navigation-mobile";
import { SidebarAccountFooter } from "./footer/sidebar-footer";
import { SidebarAccountFooterMobile } from "./footer/sidebar-footer-mobile";
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
        footer={<SidebarAccountFooter />}
        additionalContent={
          <ErrorBoundary>
            <Suspense fallback={<TaskGroupsSkeleton />}>
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
        footer={<SidebarAccountFooterMobile />}
        additionalContent={
          <ErrorBoundary>
            <Suspense fallback={<TaskGroupsSkeleton />}>
              <TaskGroupsList onNavigate={onClose} />
            </Suspense>
          </ErrorBoundary>
        }
      />
    </SidebarAgentGroupsProvider>
  );
}
