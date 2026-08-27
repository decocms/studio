import { ErrorBoundary } from "@/components/error-boundary";
import { useProjectSidebarItems } from "@/hooks/use-project-sidebar-items";
import { Suspense } from "react";
import { NavigationSidebar } from "./navigation";
import { MobileNavigationSidebar } from "./navigation-mobile";
import { SidebarAccountFooter } from "./footer/sidebar-footer";
import { SidebarAccountFooterMobile } from "./footer/sidebar-footer-mobile";
import { TaskGroupsSkeleton } from "./task-groups/task-groups-skeleton";
import { NavSidebarContent } from "./nav-sidebar-content";
import { SidebarAgentGroupsProvider } from "./sidebar-agent-groups-context";
import { OrgSwitcherCrumb } from "@/components/header/shell-breadcrumb";
import { SidebarTriggerButton } from "@/layouts/shell-controls";

export type {
  NavigationSidebarItem,
  SidebarSection,
  SidebarItemGroup,
  Invitation,
} from "./types";

/**
 * The sidebar header: the named org plus the collapse trigger, so the
 * destinations start flush at the top. The active agent is named in the chat
 * panel header instead.
 */
function SidebarOwnHeader() {
  return (
    <>
      <OrgSwitcherCrumb showName />
      <SidebarTriggerButton className="ml-auto md:size-[34px] rounded-lg" />
    </>
  );
}

/** The sidebar body: the destinations list (Reports / Library / Tasks). */
function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<TaskGroupsSkeleton />}>
        <NavSidebarContent onNavigate={onNavigate} />
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
