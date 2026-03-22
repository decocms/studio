import {
  Outlet,
  useParams,
  Link,
  useRouterState,
} from "@tanstack/react-router";
import { Suspense, useState } from "react";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { useProjectContext } from "@decocms/mesh-sdk";
import { Page } from "@/web/components/page";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@deco/ui/components/breadcrumb.tsx";
import { ArrowLeft } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { ProjectSettingsSidebar, SETTINGS_ITEMS } from "./settings-sidebar";

function ContentSkeleton() {
  return (
    <div className="flex flex-col gap-4 pt-2">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-4 w-80" />
      <div className="mt-4 flex flex-col gap-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    </div>
  );
}

function ProjectSettingsContent() {
  const params = useParams({
    from: "/shell/$org/projects/$virtualMcpId/settings",
  });
  const { project } = useProjectContext();
  const { location } = useRouterState();
  const [mobileShowContent, setMobileShowContent] = useState(true);

  // Find the active settings page label for the mobile header
  const activeItem = SETTINGS_ITEMS.find((item) =>
    location.pathname.endsWith(`/settings/${item.key}`),
  );
  const activeLabel = activeItem?.label ?? "Settings";

  return (
    <Page>
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link
                    to="/$org/projects"
                    params={{
                      org: params.org,
                    }}
                  >
                    Projects
                  </Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link
                    to="/$org/projects/$virtualMcpId"
                    params={{
                      org: params.org,
                      virtualMcpId: params.virtualMcpId,
                    }}
                  >
                    {project.name}
                  </Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>Settings</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Page.Header.Left>
      </Page.Header>
      <Page.Content className="flex">
        {/* Sidebar - always visible on desktop, toggleable on mobile */}
        <div
          className={cn(
            mobileShowContent ? "hidden" : "flex",
            "sm:flex flex-col w-full sm:w-auto",
          )}
        >
          <ProjectSettingsSidebar
            onNavigate={() => setMobileShowContent(true)}
          />
        </div>

        {/* Content - always visible on desktop, toggleable on mobile */}
        <div
          className={cn(
            mobileShowContent ? "flex" : "hidden",
            "sm:flex flex-1 min-w-0 flex-col overflow-hidden",
          )}
        >
          {/* Mobile back header */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border sm:hidden">
            <button
              type="button"
              onClick={() => setMobileShowContent(false)}
              className="rounded-md p-1 opacity-70 hover:opacity-100 transition-opacity"
            >
              <ArrowLeft size={16} />
              <span className="sr-only">Back</span>
            </button>
            <span className="text-sm font-semibold">{activeLabel}</span>
          </div>

          <div className="flex-1 overflow-y-auto p-5 sm:p-8">
            <Suspense fallback={<ContentSkeleton />}>
              <Outlet />
            </Suspense>
          </div>
        </div>
      </Page.Content>
    </Page>
  );
}

export default function ProjectSettingsLayout() {
  return (
    <Suspense fallback={null}>
      <ProjectSettingsContent />
    </Suspense>
  );
}
