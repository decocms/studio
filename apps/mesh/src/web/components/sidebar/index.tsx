import { ErrorBoundary } from "@/web/components/error-boundary";
import { useProjectSidebarItems } from "@/web/hooks/use-project-sidebar-items";
import { Suspense } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useProjectContext } from "@decocms/mesh-sdk";
import { NavigationSidebar } from "./navigation";
import { MobileNavigationSidebar } from "./navigation-mobile";
import { SidebarInboxFooter } from "./footer/inbox";
import { SidebarInboxFooterMobile } from "./footer/inbox-mobile";
import { SidebarTopActions } from "./top-actions";
import { TaskGroupsList } from "./task-groups/task-groups-list";

export type {
  NavigationSidebarItem,
  SidebarSection,
  SidebarItemGroup,
  Invitation,
} from "./types";

function useNavigateHome() {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  return () => navigate({ to: "/$org", params: { org: org.slug } });
}

export function StudioSidebar() {
  const sections = useProjectSidebarItems();
  const goHome = useNavigateHome();

  return (
    <NavigationSidebar
      sections={sections}
      onLogoClick={goHome}
      footer={<SidebarInboxFooter />}
      additionalContent={
        <ErrorBoundary>
          <Suspense
            fallback={
              <div className="px-2 py-2 text-xs text-muted-foreground">
                Loading tasks…
              </div>
            }
          >
            <SidebarTopActions />
            <TaskGroupsList />
          </Suspense>
        </ErrorBoundary>
      }
    />
  );
}

export function StudioSidebarMobile({ onClose }: { onClose: () => void }) {
  const sections = useProjectSidebarItems();
  const goHome = useNavigateHome();

  return (
    <MobileNavigationSidebar
      sections={sections}
      onLogoClick={() => {
        goHome();
        onClose();
      }}
      onClose={onClose}
      footer={<SidebarInboxFooterMobile />}
      additionalContent={
        <ErrorBoundary>
          <Suspense fallback={null}>
            <SidebarTopActions />
            <TaskGroupsList />
          </Suspense>
        </ErrorBoundary>
      }
    />
  );
}
