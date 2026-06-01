/**
 * Settings Shell Layout
 *
 * Wraps `/$org/settings/...` routes. Mirrors the org shell shape:
 *   SidebarProvider
 *   └── app-shell-root (flex-col, h-dvh)
 *       ├── Toolbar.Header           — full-width, "← Settings" + trigger + back/forward
 *       └── SidebarLayout            — body row
 *           ├── SettingsSidebar      — desktop only
 *           └── SidebarInset         — content card with routed children
 *   + MobileSidebarSheet for the mobile sidebar
 */

import {
  Outlet,
  Link,
  useRouterState,
  useParams,
} from "@tanstack/react-router";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarInset,
  SidebarLayout,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@deco/ui/components/sidebar.tsx";
import { PageContentClassNameProvider } from "@/web/components/page";
import {
  BarChart10,
  BookOpen01,
  Building02,
  ZapSquare,
  CpuChip01,
  Loading01,
  Lock01,
  LogOut01,
  PackageCheck,
  Shield01,
  User01,
  Users03,
  Zap,
  Key01,
  HardDrive,
} from "@untitledui/icons";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useCapabilities, type CapabilityId } from "@/web/hooks/use-capability";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { Suspense } from "react";
import { pluginSettingsSidebarItems } from "@/web/index";
import { useStatusSounds } from "../hooks/use-status-sounds";
import { authClient } from "@/web/lib/auth-client";
import { track } from "@/web/lib/posthog-client";
import { clearPersistedQueryCache } from "@/web/lib/query-persist";
import { Toolbar } from "@/web/layouts/agent-shell-layout/toolbar";
import {
  MobileSidebarSheet,
  SidebarTriggerButton,
} from "@/web/layouts/shell-controls";

interface SettingsNavItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  to: string;
  /** Capability required to see this item. Omitted = visible to every member. */
  requires?: CapabilityId;
}

interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

function useSettingsSidebarGroups(): SettingsNavGroup[] {
  const currentProject = useProjectContext().project;
  const enabledPlugins = currentProject.enabledPlugins ?? [];
  const { capabilities, isPrivileged, loading, error } = useCapabilities();

  const enabledSettingsItems = pluginSettingsSidebarItems
    .filter((item) => enabledPlugins.includes(item.pluginId))
    .map(({ key, label, icon, to }) => ({ key, label, icon, to }));

  const groups: SettingsNavGroup[] = [
    {
      label: "Organization",
      items: [
        {
          key: "general",
          label: "General",
          icon: <Building02 size={14} />,
          to: "/$org/settings/general",
          requires: "org:manage",
        },
        {
          key: "brand-context",
          label: "Brand Context",
          icon: <BookOpen01 size={14} />,
          to: "/$org/settings/brand-context",
          requires: "org:manage",
        },
        {
          key: "ai-providers",
          label: "AI Providers",
          icon: <CpuChip01 size={14} />,
          to: "/$org/settings/ai-providers",
          requires: "ai-providers:manage",
        },
        {
          key: "secrets",
          label: "Secrets",
          icon: <Key01 size={14} />,
          to: "/$org/settings/secrets",
          requires: "secrets:manage",
        },
        {
          key: "files",
          label: "Files",
          icon: <HardDrive size={14} />,
          to: "/$org/settings/files",
          requires: "file-configs:manage",
        },
      ],
    },
    {
      label: "Build",
      items: [
        // connections + agents map to heavy route components that aren't
        // capability-guarded yet — gated fully (nav + route + actions) in a
        // follow-up, so leave them visible here to avoid half-gating.
        {
          key: "connections",
          label: "Connections",
          icon: <ZapSquare size={14} />,
          to: "/$org/settings/connections",
        },
        {
          key: "agents",
          label: "Agents",
          icon: <Users03 size={14} />,
          to: "/$org/settings/agents",
        },
        {
          key: "automations",
          label: "Automations",
          icon: <Zap size={14} />,
          to: "/$org/settings/automations",
          requires: "automations:manage",
        },
        {
          key: "store",
          label: "Store",
          icon: <PackageCheck size={14} />,
          to: "/$org/settings/store",
          requires: "registry:manage",
        },
      ],
    },
    {
      label: "Manage",
      items: [
        {
          // Monitor's route isn't capability-guarded yet (see Build note); gated
          // fully in the follow-up. Visible to all members for now.
          key: "monitor",
          label: "Monitor",
          icon: <BarChart10 size={14} />,
          to: "/$org/settings/monitor",
        },
        {
          key: "members",
          label: "Members",
          icon: <Users03 size={14} />,
          to: "/$org/settings/members",
          requires: "members:manage",
        },
        {
          key: "roles",
          label: "Roles",
          icon: <Shield01 size={14} />,
          to: "/$org/settings/roles",
          requires: "members:manage",
        },
        {
          key: "sso",
          label: "Security",
          icon: <Lock01 size={14} />,
          to: "/$org/settings/sso",
          requires: "org:manage",
        },
      ],
    },
    {
      label: "Extensions",
      items: [
        {
          key: "features",
          label: "Plugins",
          icon: <Zap size={14} />,
          to: "/$org/settings/features",
          requires: "org:manage",
        },
        ...enabledSettingsItems,
      ],
    },
    {
      label: "Account",
      items: [
        {
          key: "profile",
          label: "Profile & Preferences",
          icon: <User01 size={14} />,
          to: "/$org/settings/profile",
        },
      ],
    },
  ];

  // While capabilities load — or if the lookup errored — show every item
  // optimistically. This avoids a flicker for the common privileged case and
  // ensures a transient failure never hides nav from owners/admins. Once
  // resolved, hide items the member's role can't open and drop any group left
  // empty. Items without a `requires` (Profile, plugin items) are always shown.
  if (loading || error) {
    return groups;
  }
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) => !item.requires || isPrivileged || capabilities[item.requires],
      ),
    }))
    .filter((group) => group.items.length > 0);
}

export function SettingsSidebar() {
  const groups = useSettingsSidebarGroups();
  const { org } = useParams({ from: "/shell/$org" });
  const pathname = useRouterState({
    select: (s) => s.location.pathname,
  });

  const isActive = (to: string) => {
    const resolved = to.replace("$org", org);
    return pathname.startsWith(resolved);
  };

  return (
    <Sidebar variant="sidebar">
      <SidebarContent className="flex flex-col flex-1 mt-2 px-2 pb-2 gap-0 overflow-y-auto">
        {groups.map((group, i) => (
          <SidebarGroup
            key={`${group.label}-${i}`}
            className="pt-0 pr-0 pb-0 pl-0"
          >
            {group.label && (
              <p
                className={cn(
                  "px-2 pt-1.5 pb-0.5 text-xs font-medium text-muted-foreground/60",
                  i > 0 && "mt-3",
                )}
              >
                {group.label}
              </p>
            )}
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.key}>
                    <SidebarMenuButton asChild isActive={isActive(item.to)}>
                      <Link
                        to={item.to}
                        params={{ org }}
                        onClick={() =>
                          track("settings_nav_clicked", {
                            section_key: item.key,
                            section_label: item.label,
                            group_label: group.label || "main",
                          })
                        }
                        className="flex items-center gap-2.5 text-sm"
                      >
                        <span className="shrink-0">{item.icon}</span>
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}

        {/* Sign Out */}
        <SidebarGroup className="pt-0 pr-0 pb-0 pl-0">
          <div className="mx-2 my-2 border-t border-border/50" />
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => {
                    track("signed_out", { source: "settings_sidebar" });
                    clearPersistedQueryCache();
                    authClient.signOut();
                  }}
                  className="flex items-center gap-2.5 text-sm"
                >
                  <span className="shrink-0">
                    <LogOut01 size={14} />
                  </span>
                  <span className="truncate">Sign Out</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* Version */}
      <div className="mt-auto px-4 pb-1">
        <span className="text-xs text-muted-foreground/50">
          v{__MESH_VERSION__}
        </span>
      </div>
    </Sidebar>
  );
}

export function SettingsSidebarMobile({ onClose }: { onClose: () => void }) {
  const groups = useSettingsSidebarGroups();
  const { org } = useParams({ from: "/shell/$org" });
  const pathname = useRouterState({
    select: (s) => s.location.pathname,
  });

  const isActive = (to: string) => {
    const resolved = to.replace("$org", org);
    return pathname.startsWith(resolved);
  };

  return (
    <div className="flex flex-col h-full bg-sidebar">
      <div className="flex flex-col flex-1 overflow-y-auto px-2 py-2 gap-0.5">
        {groups.map((group, i) => (
          <div key={`${group.label}-${i}`} className="flex flex-col gap-0.5">
            {group.label && (
              <p
                className={cn(
                  "px-3 pt-1.5 pb-0.5 text-xs font-medium text-muted-foreground/60",
                  i > 0 && "mt-3",
                )}
              >
                {group.label}
              </p>
            )}
            {group.items.map((item) => (
              <Link
                key={item.key}
                to={item.to}
                params={{ org }}
                onClick={onClose}
                className={cn(
                  "flex items-center gap-3 w-full px-3 py-2.5 rounded-lg transition-colors text-sm",
                  isActive(item.to)
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                )}
              >
                <span className="shrink-0">{item.icon}</span>
                <span className="truncate">{item.label}</span>
              </Link>
            ))}
          </div>
        ))}

        {/* Sign Out */}
        <div className="flex flex-col gap-0.5">
          <div className="h-px bg-border/50 my-2" />
          <button
            type="button"
            onClick={() => {
              clearPersistedQueryCache();
              authClient.signOut();
            }}
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg transition-colors text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <span className="shrink-0">
              <LogOut01 size={14} />
            </span>
            <span className="truncate">Sign Out</span>
          </button>
        </div>
      </div>

      {/* Version */}
      <div className="px-4 pb-3 pt-1 border-t border-border/50">
        <span className="text-xs text-muted-foreground/50">
          v{__MESH_VERSION__}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings inset — content card holding routed children
// ---------------------------------------------------------------------------

function SettingsInset() {
  const isMobile = useIsMobile();
  const { org } = useProjectContext();

  // Org-wide SSE sound notifications
  useStatusSounds(org.slug);

  const content = (
    <Suspense
      fallback={
        <div className="flex-1 flex items-center justify-center">
          <Loading01 size={20} className="animate-spin text-muted-foreground" />
        </div>
      }
    >
      <div className="flex flex-1 items-center overflow-hidden rounded-[inherit]">
        <PageContentClassNameProvider value="p-0">
          <div className="flex-1 min-w-0 overflow-hidden h-full">
            <Outlet />
          </div>
        </PageContentClassNameProvider>
      </div>
    </Suspense>
  );

  if (isMobile) {
    return (
      <div className="flex flex-col flex-1 bg-background min-h-0 overflow-hidden">
        {content}
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 p-1">
      <div
        className={cn(
          "flex flex-col h-full min-h-0 bg-background overflow-hidden",
          "card-shadow",
          "rounded-[0.75rem]",
        )}
      >
        {content}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Default export — the shell layout component for settings routes
// ---------------------------------------------------------------------------

export default function SettingsLayout() {
  const isMobile = useIsMobile();

  return (
    <Toolbar.Provider>
      <SidebarProvider defaultOpen={true}>
        <div className="app-shell-root flex flex-col h-dvh overflow-hidden">
          <Toolbar.Header>
            <Toolbar.LeftColumn>
              <Toolbar.LogoLink />
              {isMobile && <SidebarTriggerButton />}
              <span className="hidden md:contents">
                <Toolbar.Nav />
              </span>
            </Toolbar.LeftColumn>
            <Toolbar.CenterSlot />
            <Toolbar.RightColumn>
              <span />
            </Toolbar.RightColumn>
          </Toolbar.Header>
          <SidebarLayout
            className="flex-1 bg-sidebar min-h-0"
            style={
              {
                "--sidebar-width-icon": "3.5rem",
              } as Record<string, string>
            }
          >
            {!isMobile && <SettingsSidebar />}
            <SidebarInset
              className="flex flex-col"
              style={{
                background: "transparent",
                containerType: "inline-size",
              }}
            >
              <SettingsInset />
            </SidebarInset>
          </SidebarLayout>
          {isMobile && (
            <MobileSidebarSheet
              renderSidebar={({ onClose }) => (
                <SettingsSidebarMobile onClose={onClose} />
              )}
            />
          )}
        </div>
      </SidebarProvider>
    </Toolbar.Provider>
  );
}
