import { Suspense } from "react";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Beaker01,
  Building02,
  Coins01,
  Settings01,
  Zap,
} from "@untitledui/icons";
import { authClient } from "@/web/lib/auth-client";
import { ORG_ADMIN_PROJECT_SLUG, useProjectContext } from "@decocms/mesh-sdk";
import { usePreferences } from "@/web/hooks/use-preferences.ts";
import {
  parseProjectSection,
  projectSection,
  type SettingsSection,
} from "@/web/hooks/use-settings-modal";
import { useProjects } from "@/web/hooks/use-project";

const PROJECT_SUB_ITEMS = [
  { key: "general" as const, label: "General", icon: <Settings01 size={14} /> },
  { key: "plugins" as const, label: "Plugins", icon: <Zap size={14} /> },
];

function ProjectsSection({
  activeSection,
  onNavigate,
}: {
  activeSection: SettingsSection;
  onNavigate: (section: SettingsSection) => void;
}) {
  const { org } = useProjectContext();
  const { data: projects } = useProjects(org.id, { suspense: true });

  const activeProject = parseProjectSection(activeSection);

  return (
    <>
      {(projects ?? [])
        .filter((p) => p.slug !== ORG_ADMIN_PROJECT_SLUG)
        .map((project) => {
          const isExpanded = activeProject?.slug === project.slug;

          return (
            <div key={project.slug} className="flex flex-col gap-0.5">
              <button
                type="button"
                onClick={() =>
                  onNavigate(projectSection(project.slug, "general"))
                }
                className={cn(
                  "flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm text-left w-full transition-colors",
                  isExpanded
                    ? "text-foreground font-medium"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <div
                  className="size-4 shrink-0 rounded-[3px] flex items-center justify-center overflow-hidden border border-border/50"
                  style={{
                    backgroundColor: project.ui?.themeColor ?? "#60a5fa",
                  }}
                >
                  {project.ui?.icon ? (
                    <img
                      src={project.ui.icon}
                      alt=""
                      className="size-full object-cover"
                    />
                  ) : (
                    <span className="text-[8px] font-semibold text-white leading-none">
                      {(project.name ?? project.slug).charAt(0).toUpperCase()}
                    </span>
                  )}
                </div>
                <span className="truncate">{project.name ?? project.slug}</span>
              </button>

              {isExpanded && (
                <div className="ml-3 flex flex-col gap-0.5 border-l border-border pl-2.5">
                  {PROJECT_SUB_ITEMS.map((sub) => {
                    const key = projectSection(project.slug, sub.key);
                    return (
                      <button
                        key={sub.key}
                        type="button"
                        onClick={() => onNavigate(key)}
                        className={cn(
                          "flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm text-left w-full transition-colors",
                          activeSection === key
                            ? "bg-accent text-accent-foreground font-medium"
                            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                        )}
                      >
                        <span className="shrink-0">{sub.icon}</span>
                        <span className="truncate">{sub.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
    </>
  );
}

interface SettingsSidebarProps {
  activeSection: SettingsSection;
  onNavigate: (section: SettingsSection) => void;
}

export function SettingsSidebar({
  activeSection,
  onNavigate,
}: SettingsSidebarProps) {
  const { data: session } = authClient.useSession();
  const [preferences] = usePreferences();
  const user = session?.user;
  const userImage = (user as { image?: string } | undefined)?.image;

  const accountItems = [
    {
      key: "account.profile" as SettingsSection,
      label: user?.name ?? "Profile",
      icon: (
        <Avatar
          url={userImage}
          fallback={user?.name ?? "U"}
          shape="circle"
          size="2xs"
          className="size-4 shrink-0"
        />
      ),
    },
    {
      key: "account.preferences" as SettingsSection,
      label: "Preferences",
      icon: <Settings01 size={14} />,
    },
    {
      key: "account.experimental" as SettingsSection,
      label: "Experimental",
      icon: <Beaker01 size={14} />,
    },
  ];

  const orgItems = [
    {
      key: "org.general" as SettingsSection,
      label: "General",
      icon: <Building02 size={14} />,
    },
    {
      key: "org.plugins" as SettingsSection,
      label: "Plugins",
      icon: <Zap size={14} />,
    },
    {
      key: "org.billing" as SettingsSection,
      label: "Billing",
      icon: <Coins01 size={14} />,
    },
  ];

  return (
    <div className="w-52 shrink-0 border-r border-border bg-sidebar/50 overflow-y-auto py-3 flex flex-col gap-4">
      {/* Account */}
      <div className="flex flex-col gap-0.5 px-2">
        <p className="px-2 py-1.5 text-xs font-semibold text-muted-foreground/60">
          Account
        </p>
        {accountItems.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => onNavigate(item.key)}
            className={cn(
              "flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm text-left w-full transition-colors",
              activeSection === item.key
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <span className="shrink-0">{item.icon}</span>
            <span className="truncate">{item.label}</span>
          </button>
        ))}
      </div>

      {/* Organization */}
      <div className="flex flex-col gap-0.5 px-2">
        <p className="px-2 py-1.5 text-xs font-semibold text-muted-foreground/60">
          Organization
        </p>
        {orgItems.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => onNavigate(item.key)}
            className={cn(
              "flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm text-left w-full transition-colors",
              activeSection === item.key
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <span className="shrink-0">{item.icon}</span>
            <span className="truncate">{item.label}</span>
          </button>
        ))}
      </div>

      {/* Projects */}
      {preferences.experimental_projects && (
        <div className="flex flex-col gap-0.5 px-2">
          <p className="px-2 py-1.5 text-xs font-semibold text-muted-foreground/60">
            Projects
          </p>
          <Suspense
            fallback={
              <div className="px-2 py-1.5 text-xs text-muted-foreground/50">
                Loading…
              </div>
            }
          >
            <ProjectsSection
              activeSection={activeSection}
              onNavigate={onNavigate}
            />
          </Suspense>
        </div>
      )}
      {/* Version */}
      <div className="mt-auto px-4 pb-1">
        <span className="text-xs text-muted-foreground/50">
          v{__MESH_VERSION__}
        </span>
      </div>
    </div>
  );
}
