import { Avatar } from "@deco/ui/components/avatar.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Building02,
  Coins01,
  Settings01,
  Users03,
  Zap,
  CpuChip01,
  Lock01,
} from "@untitledui/icons";
import { authClient } from "@/web/lib/auth-client";
import { type SettingsSection } from "@/web/hooks/use-settings-modal";

interface SettingsSidebarProps {
  activeSection: SettingsSection;
  onNavigate: (section: SettingsSection) => void;
}

export function SettingsSidebar({
  activeSection,
  onNavigate,
}: SettingsSidebarProps) {
  const { data: session } = authClient.useSession();
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
  ];

  const orgItems = [
    {
      key: "org.general" as SettingsSection,
      label: "General",
      icon: <Building02 size={14} />,
    },
    {
      key: "org.plugins" as SettingsSection,
      label: "Features",
      icon: <Zap size={14} />,
    },
    {
      key: "org.ai-providers" as SettingsSection,
      label: "AI Providers",
      icon: <CpuChip01 size={14} />,
    },
    {
      key: "org.members" as SettingsSection,
      label: "Members",
      icon: <Users03 size={14} />,
    },
    {
      key: "org.sso" as SettingsSection,
      label: "SSO",
      icon: <Lock01 size={14} />,
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

      {/* Version */}
      <div className="mt-auto px-4 pb-1">
        <span className="text-xs text-muted-foreground/50">
          v{__MESH_VERSION__}
        </span>
      </div>
    </div>
  );
}
