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
  useSidebar,
} from "@deco/ui/components/sidebar.tsx";
import { Sheet, SheetContent, SheetTitle } from "@deco/ui/components/sheet.tsx";
import { PageContentClassNameProvider } from "@/web/components/page";
import {
  ArrowNarrowLeft,
  BarChart10,
  BookOpen01,
  Building02,
  ChevronLeft,
  ChevronRight,
  ZapSquare,
  CpuChip01,
  Loading01,
  Lock01,
  LogOut01,
  Menu01,
  PackageCheck,
  Shield01,
  User01,
  Users03,
  Zap,
} from "@untitledui/icons";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { Suspense } from "react";
import { pluginSettingsSidebarItems } from "@/web/index";
import { useStatusSounds } from "../hooks/use-status-sounds";
import { authClient } from "@/web/lib/auth-client";
import { track } from "@/web/lib/posthog-client";

interface SettingsNavItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  to: string;
}

interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

function useSettingsSidebarGroups(): SettingsNavGroup[] {
  const currentProject = useProjectContext().project;
  const enabledPlugins = currentProject.enabledPlugins ?? [];

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
        },
        {
          key: "brand-context",
          label: "Brand Context",
          icon: <BookOpen01 size={14} />,
          to: "/$org/settings/brand-context",
        },
        {
          key: "ai-providers",
          label: "AI Providers",
          icon: <CpuChip01 size={14} />,
          to: "/$org/settings/ai-providers",
        },
      ],
    },
    {
      label: "Build",
      items: [
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
        },
        {
          key: "store",
          label: "Store",
          icon: <PackageCheck size={14} />,
          to: "/$org/settings/store",
        },
      ],
    },
    {
      label: "Manage",
      items: [
        {
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
        },
        {
          key: "roles",
          label: "Roles",
          icon: <Shield01 size={14} />,
          to: "/$org/settings/roles",
        },
        {
          key: "sso",
          label: "Security",
          icon: <Lock01 size={14} />,
          to: "/$org/settings/sso",
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

  return groups;
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
      <SidebarContent className="flex flex-col flex-1 mt-2 px-2 pb-2 gap-0">
        {/* Back to org */}
        <SidebarGroup className="pt-0 pr-0 pb-3 md:pb-3 pl-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-1.5">
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <Link
                    to="/$org"
                    params={{ org }}
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                  >
                    <ArrowNarrowLeft size={14} />
                    <span>Settings</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

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
      {/* Header with back button */}
      <div className="flex items-center h-14 px-4 shrink-0 border-b border-border/50">
        <Link
          to="/$org"
          params={{ org }}
          onClick={onClose}
          className="flex items-center gap-2 text-sm font-semibold text-foreground"
        >
          <ArrowNarrowLeft size={16} className="shrink-0" />
          <span>Settings</span>
        </Link>
      </div>

      {/* Nav items */}
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
            onClick={() => authClient.signOut()}
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
// Settings toolbar — back/forward navigation only (no panel toggles)
// ---------------------------------------------------------------------------

function SettingsToolbar() {
  return (
    <div className="shrink-0 flex items-center justify-between pl-1 pr-2 h-10">
      <div className="flex items-center gap-0.5 min-w-0">
        <button
          type="button"
          onClick={() => window.history.back()}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
          title="Go back"
        >
          <ChevronLeft size={16} />
        </button>
        <button
          type="button"
          onClick={() => window.history.forward()}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
          title="Go forward"
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

function MobileToolbar({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  return (
    <div className="shrink-0 flex items-center justify-between px-3 h-12 bg-background border-b border-border">
      <button
        type="button"
        onClick={onOpenSidebar}
        className="flex size-8 items-center justify-center rounded-md text-foreground/60 hover:bg-accent hover:text-foreground transition-colors"
        aria-label="Open menu"
      >
        <Menu01 size={20} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings inset — lightweight content area (no Chat, no virtualMCP)
// ---------------------------------------------------------------------------

function SettingsInset() {
  const isMobile = useIsMobile();
  const { org } = useProjectContext();

  // Org-wide SSE sound notifications
  useStatusSounds(org.slug);

  const { setOpenMobile, openMobile: mobileSidebarOpen } = useSidebar();

  if (isMobile) {
    return (
      <div className="flex flex-col flex-1 bg-background min-h-0">
        <MobileToolbar onOpenSidebar={() => setOpenMobile(true)} />
        <div className="flex-1 overflow-hidden">
          <PageContentClassNameProvider value="p-0">
            <div className="flex-1 min-w-0 overflow-hidden h-full">
              <Outlet />
            </div>
          </PageContentClassNameProvider>
        </div>
        <Sheet open={mobileSidebarOpen} onOpenChange={setOpenMobile}>
          <SheetContent
            side="left"
            hideCloseButton
            className="w-[calc(100vw-3rem)] sm:max-w-md! p-0"
          >
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SettingsSidebarMobile onClose={() => setOpenMobile(false)} />
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  return (
    <>
      <SettingsToolbar />
      <div className="flex-1 min-h-0 p-1">
        <div
          className={cn(
            "flex flex-col h-full min-h-0 bg-background overflow-hidden",
            "card-shadow",
            "rounded-[0.75rem]",
          )}
        >
          <Suspense
            fallback={
              <div className="flex-1 flex items-center justify-center">
                <Loading01
                  size={20}
                  className="animate-spin text-muted-foreground"
                />
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
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Default export — the shell layout component for settings routes
// ---------------------------------------------------------------------------

export default function SettingsLayout() {
  return (
    <SidebarProvider defaultOpen={true}>
      <div className="flex flex-col h-dvh overflow-hidden">
        <SidebarLayout
          className="flex-1 bg-sidebar"
          style={
            {
              "--sidebar-width-icon": "3.5rem",
            } as Record<string, string>
          }
        >
          <SettingsSidebar />
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
      </div>
    </SidebarProvider>
  );
}
