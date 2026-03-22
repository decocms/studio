import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { ArrowLeft, X } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { Suspense, useState } from "react";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import {
  useSettingsModal,
  type SettingsSection,
} from "@/web/hooks/use-settings-modal";
import {
  ProjectContextProvider,
  useProjectContext,
  useVirtualMCP,
} from "@decocms/mesh-sdk";
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
  projectId,
  children,
}: {
  projectId: string;
  children: React.ReactNode;
}) {
  const { org } = useProjectContext();
  const entity = useVirtualMCP(projectId);

  if (!entity) return <ContentSkeleton />;

  const ui = entity.metadata?.ui;

  return (
    <ProjectContextProvider
      org={org}
      project={{
        id: entity.id,
        organizationId: entity.organization_id,
        slug: entity.id,
        name: entity.title,
        description: entity.description,
        enabledPlugins:
          (entity.metadata?.enabled_plugins as string[] | null) ?? null,
        ui: ui
          ? {
              banner: ui.banner ?? null,
              bannerColor: ui.bannerColor ?? null,
              icon: ui.icon ?? null,
              themeColor: ui.themeColor ?? null,
            }
          : null,
        isOrgAdmin: false,
      }}
    >
      {children}
    </ProjectContextProvider>
  );
}

function SettingsContent({ section }: { section: SettingsSection }) {
  const { org } = useProjectContext();
  switch (section) {
    case "account.profile":
      return <AccountProfilePage />;
    case "account.preferences":
      return <AccountPreferencesPage />;
    case "org.general":
      return <OrgGeneralPage />;
    case "org.plugins":
      return (
        <ProjectContextWrapper projectId={org.id}>
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

const SECTION_LABELS: Record<SettingsSection, string> = {
  "account.profile": "Profile",
  "account.preferences": "Preferences",
  "org.general": "General",
  "org.plugins": "Features",
  "org.ai-providers": "AI Providers",
  "org.billing": "Billing",
  "org.members": "Members",
};

export function SettingsModal() {
  const { isOpen, activeSection, open, close } = useSettingsModal();
  const [mobileShowContent, setMobileShowContent] = useState(false);
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  if (prevIsOpen !== isOpen) {
    setPrevIsOpen(isOpen);
    setMobileShowContent(isOpen);
  }

  const handleNavigate = (section: SettingsSection) => {
    open(section);
    setMobileShowContent(true);
  };

  const handleBack = () => {
    setMobileShowContent(false);
  };

  const handleClose = (v: boolean) => {
    if (!v) {
      close();
      setMobileShowContent(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent
        className="sm:max-w-[1100px] h-[100dvh] sm:h-[85vh] max-h-[100dvh] sm:max-h-[85vh] w-full max-w-full sm:max-w-[1100px] rounded-none sm:rounded-xl p-0 overflow-hidden flex flex-col gap-0 border-0 sm:border"
        closeButtonClassName="hidden"
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Sidebar - always visible on desktop, toggleable on mobile */}
          <div
            className={cn(
              mobileShowContent ? "hidden" : "flex",
              "sm:flex flex-col w-full sm:w-auto",
            )}
          >
            {/* Mobile header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border sm:hidden">
              <span className="text-base font-semibold">Settings</span>
              <button
                type="button"
                onClick={() => handleClose(false)}
                className="rounded-md p-1 opacity-70 hover:opacity-100 transition-opacity"
              >
                <X size={16} />
                <span className="sr-only">Close</span>
              </button>
            </div>
            <Suspense
              fallback={
                <div className="w-full sm:w-52 shrink-0 border-r border-border" />
              }
            >
              <SettingsSidebar
                activeSection={activeSection}
                onNavigate={handleNavigate}
              />
            </Suspense>
          </div>

          {/* Content - always visible on desktop, toggleable on mobile */}
          <div
            className={cn(
              mobileShowContent ? "flex" : "hidden",
              "sm:flex flex-1 min-w-0 overflow-y-auto relative flex-col overflow-hidden",
            )}
          >
            {/* Mobile back header */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border sm:hidden">
              <button
                type="button"
                onClick={handleBack}
                className="rounded-md p-1 opacity-70 hover:opacity-100 transition-opacity"
              >
                <ArrowLeft size={16} />
                <span className="sr-only">Back</span>
              </button>
              <span className="text-base font-semibold">
                {SECTION_LABELS[activeSection]}
              </span>
            </div>

            {/* Desktop close button */}
            <button
              type="button"
              onClick={() => handleClose(false)}
              className="hidden sm:block absolute top-4 right-4 z-10 rounded-md p-1 opacity-70 hover:opacity-100 transition-opacity focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <X size={16} />
              <span className="sr-only">Close</span>
            </button>

            <div className="p-5 sm:p-8 flex-1 overflow-y-auto">
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
