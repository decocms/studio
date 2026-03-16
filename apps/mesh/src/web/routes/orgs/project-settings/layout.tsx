import { Outlet, useParams, Link } from "@tanstack/react-router";
import { Suspense } from "react";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { useProject } from "@/web/hooks/use-project";
import {
  ORG_ADMIN_PROJECT_SLUG,
  ProjectContextProvider,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { Page } from "@/web/components/page";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@deco/ui/components/breadcrumb.tsx";
import { ProjectSettingsSidebar } from "./settings-sidebar";
import {
  SettingsFooterProvider,
  SettingsFooterMount,
} from "@/web/components/settings/settings-footer-context";

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
  const params = useParams({ strict: false }) as {
    org: string;
    project: string;
    slug: string;
  };
  const { org } = useProjectContext();
  const slug = params.slug;

  const { data: project, isLoading } = useProject(org.id, slug);

  if (isLoading || !project) {
    return (
      <Page>
        <Page.Header>
          <Page.Header.Left>
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <Link
                      to="/$org/$project/projects"
                      params={{
                        org: params.org,
                        project: ORG_ADMIN_PROJECT_SLUG,
                      }}
                    >
                      Projects
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
        <Page.Content>
          <div className="p-8">
            <ContentSkeleton />
          </div>
        </Page.Content>
      </Page>
    );
  }

  const enhancedProject = {
    id: project.id,
    organizationId: project.organizationId,
    slug: project.slug,
    name: project.name,
    description: project.description,
    enabledPlugins: project.enabledPlugins,
    ui: project.ui,
    isOrgAdmin: project.slug === ORG_ADMIN_PROJECT_SLUG,
  };

  return (
    <ProjectContextProvider org={org} project={enhancedProject}>
      <Page>
        <Page.Header>
          <Page.Header.Left>
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <Link
                      to="/$org/$project/projects"
                      params={{
                        org: params.org,
                        project: ORG_ADMIN_PROJECT_SLUG,
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
                      to="/$org/$project"
                      params={{ org: params.org, project: project.slug }}
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
          <ProjectSettingsSidebar />
          <SettingsFooterProvider>
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto p-8">
                <Suspense fallback={<ContentSkeleton />}>
                  <Outlet />
                </Suspense>
              </div>
              <SettingsFooterMount />
            </div>
          </SettingsFooterProvider>
        </Page.Content>
      </Page>
    </ProjectContextProvider>
  );
}

export default function ProjectSettingsLayout() {
  return (
    <Suspense fallback={null}>
      <ProjectSettingsContent />
    </Suspense>
  );
}
