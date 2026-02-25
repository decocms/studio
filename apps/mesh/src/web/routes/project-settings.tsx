import { Page } from "@/web/components/page";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@deco/ui/components/breadcrumb.tsx";
import { useProjectContext, ORG_ADMIN_PROJECT_SLUG } from "@decocms/mesh-sdk";
import { ProjectGeneralForm } from "@/web/components/settings/project-general-form";
import { ProjectPluginsForm } from "@/web/components/settings/project-plugins-form";
import { OrganizationForm } from "@/web/components/settings/organization-form";
import { DangerZone } from "@/web/components/settings/danger-zone";

export default function ProjectSettingsPage() {
  const { project } = useProjectContext();
  const isOrgAdmin = project.slug === ORG_ADMIN_PROJECT_SLUG;

  return (
    <Page>
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Settings</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Page.Header.Left>
      </Page.Header>

      <Page.Content>
        <div className="flex h-full">
          <div className="flex-1 overflow-auto">
            <div className="p-5 max-w-2xl">
              <div className="space-y-8">
                {/* Organization Section - Only for org-admin */}
                {isOrgAdmin && (
                  <section className="space-y-4">
                    <div>
                      <h2 className="text-lg font-semibold text-foreground">
                        Organization
                      </h2>
                    </div>
                    <OrganizationForm />
                  </section>
                )}

                {/* General Section - Only for regular projects */}
                {!isOrgAdmin && (
                  <section className="space-y-4">
                    <div>
                      <h2 className="text-lg font-semibold text-foreground">
                        General
                      </h2>
                    </div>
                    <ProjectGeneralForm />
                  </section>
                )}

                {/* Plugins Section */}
                <section className="space-y-4">
                  <div>
                    <h2 className="text-lg font-semibold text-foreground">
                      Plugins
                    </h2>
                    <p className="text-sm text-muted-foreground mt-1">
                      Manage which plugins are enabled and configure them.
                    </p>
                  </div>
                  <ProjectPluginsForm />
                </section>

                {/* Danger Zone - Only for non-org-admin */}
                <DangerZone />
              </div>
            </div>
          </div>
        </div>
      </Page.Content>
    </Page>
  );
}
