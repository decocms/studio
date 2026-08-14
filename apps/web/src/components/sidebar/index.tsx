import { ErrorBoundary } from "@/components/error-boundary";
import { useProjectSidebarItems } from "@/hooks/use-project-sidebar-items";
import { Suspense } from "react";
import { NavigationSidebar } from "./navigation";
import { MobileNavigationSidebar } from "./navigation-mobile";
import { SidebarAccountFooter } from "./footer/sidebar-footer";
import { SidebarAccountFooterMobile } from "./footer/sidebar-footer-mobile";
import { TaskGroupsList } from "./task-groups/task-groups-list";
import { TaskGroupsSkeleton } from "./task-groups/task-groups-skeleton";
import { NavSidebarContent } from "./nav-sidebar-content";
import { SidebarAgentGroupsProvider } from "./sidebar-agent-groups-context";
import {
  AgentSwitcherCrumb,
  OrgSwitcherCrumb,
} from "@/components/header/shell-breadcrumb";
import { useNavV2, useReportsOnly } from "@/hooks/use-organization-settings";
import { SidebarTriggerButton } from "@/layouts/shell-controls";

export type {
  NavigationSidebarItem,
  SidebarSection,
  SidebarItemGroup,
  Invitation,
} from "./types";

/**
 * Commerce (reports-only) orgs get no agent navigation in the sidebar header —
 * just the org, named. Same under the first-class navigation, where the agent
 * crumb lives in the chat panel header instead.
 */
function SidebarOwnHeader() {
  const reportsOnly = useReportsOnly();
  const navV2 = useNavV2();
  // Collapse trigger beside the org, so the destinations start flush at the top.
  if (navV2) {
    return (
      <>
        <OrgSwitcherCrumb showName />
        <SidebarTriggerButton className="ml-auto md:size-[34px] rounded-lg" />
      </>
    );
  }
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

/** The sidebar body: destinations under the first-class navigation, the thread
 *  list otherwise. */
function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const navV2 = useNavV2();
  return (
    <ErrorBoundary>
      <Suspense fallback={<TaskGroupsSkeleton />}>
        {navV2 ? (
          <NavSidebarContent onNavigate={onNavigate} />
        ) : (
          <TaskGroupsList onNavigate={onNavigate} />
        )}
      </Suspense>
    </ErrorBoundary>
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
        additionalContent={<SidebarBody />}
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
        additionalContent={<SidebarBody onNavigate={onClose} />}
      />
    </SidebarAgentGroupsProvider>
  );
}
