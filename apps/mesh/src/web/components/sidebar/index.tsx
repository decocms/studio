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
import { SIDEBAR_NAV_BUTTONS } from "@/web/flags";
import { ShellBreadcrumb } from "@/web/components/header/shell-breadcrumb";
import { SidebarTriggerButton } from "@/web/layouts/shell-controls";

export type {
  NavigationSidebarItem,
  SidebarSection,
  SidebarItemGroup,
  Invitation,
} from "./types";

function SidebarOwnHeader() {
  return (
    <>
      <ShellBreadcrumb />
      <div className="flex-1" />
      <SidebarTriggerButton />
    </>
  );
}

export function StudioSidebar() {
  const sections = useProjectSidebarItems();

  return (
    <SidebarAgentGroupsProvider>
      <NavigationSidebar
        sections={sections}
        footer={<SidebarAccountFooter />}
        header={SIDEBAR_NAV_BUTTONS ? <SidebarOwnHeader /> : undefined}
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
