import { ErrorBoundary } from "@/components/error-boundary";
import { useProjectSidebarItems } from "@/hooks/use-project-sidebar-items";
import { Suspense } from "react";
import { NavigationSidebar } from "./navigation";
import { MobileNavigationSidebar } from "./navigation-mobile";
import { SidebarAccountFooter } from "./footer/sidebar-footer";
import { SidebarAccountFooterMobile } from "./footer/sidebar-footer-mobile";
import { TaskGroupsList } from "./task-groups/task-groups-list";
import { TaskGroupsSkeleton } from "./task-groups/task-groups-skeleton";
import { SidebarAgentGroupsProvider } from "./sidebar-agent-groups-context";
import {
  AgentSwitcherCrumb,
  OrgSwitcherCrumb,
} from "@/components/header/shell-breadcrumb";
import { useReportsOnly } from "@/hooks/use-organization-settings";

export type {
  NavigationSidebarItem,
  SidebarSection,
  SidebarItemGroup,
  Invitation,
} from "./types";

function SidebarOwnHeader() {
  const reportsOnly = useReportsOnly();
  // Commerce (reports-only) orgs get no agent navigation in the sidebar header —
  // just the org, named.
  if (reportsOnly) {
    return <OrgSwitcherCrumb showName />;
  }
  return (
    <>
      <OrgSwitcherCrumb />
      <AgentSwitcherCrumb />
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
        header={<SidebarOwnHeader />}
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
