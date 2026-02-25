import { Avatar } from "@deco/ui/components/avatar.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Beaker01,
  Building02,
  Settings01,
  Trash01,
  Zap,
} from "@untitledui/icons";
import { authClient } from "@/web/lib/auth-client";
import { ORG_ADMIN_PROJECT_SLUG, useProjectContext } from "@decocms/mesh-sdk";
import type { SettingsSection } from "@/web/hooks/use-settings-modal";

interface SidebarItem {
  key: SettingsSection;
  label: string;
  icon: React.ReactNode;
}

interface SidebarGroup {
  label: string;
  items: SidebarItem[];
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
  const { project } = useProjectContext();
  const isOrgAdmin = project.slug === ORG_ADMIN_PROJECT_SLUG;

  const user = session?.user;
  const userImage = (user as { image?: string } | undefined)?.image;

  const groups: SidebarGroup[] = [
    {
      label: "Account",
      items: [
        {
          key: "account.profile",
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
          key: "account.preferences",
          label: "Preferences",
          icon: <Settings01 size={14} />,
        },
        {
          key: "account.experimental",
          label: "Experimental",
          icon: <Beaker01 size={14} />,
        },
      ],
    },
    {
      label: "Organization",
      items: [
        {
          key: "org.general",
          label: "General",
          icon: <Building02 size={14} />,
        },
      ],
    },
    ...(!isOrgAdmin
      ? [
          {
            label: "Project",
            items: [
              {
                key: "project.general" as SettingsSection,
                label: "General",
                icon: <Settings01 size={14} />,
              },
              {
                key: "project.plugins" as SettingsSection,
                label: "Plugins",
                icon: <Zap size={14} />,
              },
              {
                key: "project.danger" as SettingsSection,
                label: "Danger Zone",
                icon: <Trash01 size={14} />,
              },
            ],
          },
        ]
      : []),
  ];

  return (
    <div className="w-52 shrink-0 border-r border-border bg-sidebar/50 overflow-y-auto py-3 flex flex-col gap-1">
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5 px-2">
          <p className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">
            {group.label}
          </p>
          {group.items.map((item) => (
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
      ))}
    </div>
  );
}
