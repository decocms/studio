import { ErrorBoundary } from "@/web/components/error-boundary";
import { useProjectSidebarItems } from "@/web/hooks/use-project-sidebar-items";
import { Suspense } from "react";
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

export function StudioSidebar() {
  const sections = useProjectSidebarItems();

  return (
    <NavigationSidebar
      sections={sections}
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

  return (
    <MobileNavigationSidebar
      sections={sections}
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
