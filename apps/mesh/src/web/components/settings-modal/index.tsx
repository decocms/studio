import { Dialog, DialogContent } from "@deco/ui/components/dialog.tsx";
import { X } from "@untitledui/icons";
import { Suspense } from "react";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import {
  parseProjectSection,
  useSettingsModal,
  type SettingsSection,
} from "@/web/hooks/use-settings-modal";
import {
  ProjectContextProvider,
  useProjectContext,
  ORG_ADMIN_PROJECT_SLUG,
} from "@decocms/mesh-sdk";
import { useProject } from "@/web/hooks/use-project";
import { SettingsSidebar } from "./sidebar";
import { AccountProfilePage } from "./pages/account-profile";
import { AccountPreferencesPage } from "./pages/account-preferences";
import { AccountExperimentalPage } from "./pages/account-experimental";
import { OrgGeneralPage } from "./pages/org-general";
import { ProjectGeneralPage } from "./pages/project-general";
import { ProjectPluginsPage } from "./pages/project-plugins";
import { ProjectDangerPage } from "./pages/project-danger";

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

function ProjectContextWrapper({
  projectSlug,
  children,
}: {
  projectSlug: string;
  children: React.ReactNode;
}) {
  const { org } = useProjectContext();
  const { data: project, isLoading } = useProject(org.id, projectSlug);

  if (isLoading || !project) return <ContentSkeleton />;

  const enhancedProject = {
    id: project.id,
    organizationId: project.organizationId,
    slug: project.slug,
    name: project.name,
    description: project.description,
    enabledPlugins: project.enabledPlugins,
    ui: project.ui,
    isOrgAdmin: false,
  };

  return (
    <ProjectContextProvider org={org} project={enhancedProject}>
      {children}
    </ProjectContextProvider>
  );
}

function SettingsContent({ section }: { section: SettingsSection }) {
  const parsed = parseProjectSection(section);

  if (parsed) {
    return (
      <ProjectContextWrapper projectSlug={parsed.slug}>
        {parsed.sub === "general" && <ProjectGeneralPage />}
        {parsed.sub === "plugins" && <ProjectPluginsPage />}
        {parsed.sub === "danger" && <ProjectDangerPage />}
      </ProjectContextWrapper>
    );
  }

  switch (section) {
    case "account.profile":
      return <AccountProfilePage />;
    case "account.preferences":
      return <AccountPreferencesPage />;
    case "account.experimental":
      return <AccountExperimentalPage />;
    case "org.general":
      return <OrgGeneralPage />;
    case "org.plugins":
      return (
        <ProjectContextWrapper projectSlug={ORG_ADMIN_PROJECT_SLUG}>
          <ProjectPluginsPage />
        </ProjectContextWrapper>
      );
    default:
      return <AccountPreferencesPage />;
  }
}

export function SettingsModal() {
  const { isOpen, activeSection, open, close } = useSettingsModal();

  return (
    <Dialog open={isOpen} onOpenChange={(v) => !v && close()}>
      <DialogContent
        className="sm:max-w-[1100px] h-[85vh] p-0 overflow-hidden flex flex-col gap-0"
        closeButtonClassName="hidden"
      >
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Left sidebar */}
          <Suspense
            fallback={<div className="w-52 shrink-0 border-r border-border" />}
          >
            <SettingsSidebar activeSection={activeSection} onNavigate={open} />
          </Suspense>

          {/* Right content */}
          <div className="flex-1 overflow-y-auto p-8 min-w-0 relative">
            {/* Close button */}
            <button
              type="button"
              onClick={close}
              className="absolute top-4 right-4 rounded-md p-1 opacity-70 hover:opacity-100 transition-opacity focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <X size={16} />
              <span className="sr-only">Close</span>
            </button>

            <Suspense fallback={<ContentSkeleton />}>
              <SettingsContent section={activeSection} />
            </Suspense>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
