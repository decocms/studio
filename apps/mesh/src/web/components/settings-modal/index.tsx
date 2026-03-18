import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { X } from "@untitledui/icons";
import { Suspense } from "react";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import {
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
import { OrgGeneralPage } from "./pages/org-general";
import { ProjectPluginsPage } from "./pages/project-plugins";
import { OrgAiProvidersPage } from "./pages/org-ai-providers";
import { OrgMembersPage } from "./pages/org-members";

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
    isOrgAdmin: projectSlug === ORG_ADMIN_PROJECT_SLUG,
  };

  return (
    <ProjectContextProvider org={org} project={enhancedProject}>
      {children}
    </ProjectContextProvider>
  );
}

function SettingsContent({ section }: { section: SettingsSection }) {
  switch (section) {
    case "account.profile":
      return <AccountProfilePage />;
    case "account.preferences":
      return <AccountPreferencesPage />;
    case "org.general":
      return <OrgGeneralPage />;
    case "org.plugins":
      return (
        <ProjectContextWrapper projectSlug={ORG_ADMIN_PROJECT_SLUG}>
          <ProjectPluginsPage />
        </ProjectContextWrapper>
      );
    case "org.ai-providers":
      return <OrgAiProvidersPage />;
    case "org.members":
      return <OrgMembersPage />;
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
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Left sidebar */}
          <Suspense
            fallback={<div className="w-52 shrink-0 border-r border-border" />}
          >
            <SettingsSidebar activeSection={activeSection} onNavigate={open} />
          </Suspense>

          {/* Right content */}
          <div className="flex-1 min-w-0 overflow-y-auto relative flex flex-col overflow-hidden">
            <button
              type="button"
              onClick={close}
              className="absolute top-4 right-4 z-10 rounded-md p-1 opacity-70 hover:opacity-100 transition-opacity focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <X size={16} />
              <span className="sr-only">Close</span>
            </button>

            <div className="p-8">
              <Suspense fallback={<ContentSkeleton />}>
                <SettingsContent section={activeSection} />
              </Suspense>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
