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
import { cn } from "@decocms/ui/lib/utils.ts";
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
} from "@decocms/ui/components/sidebar.tsx";
import { PageContentClassNameProvider } from "@/components/page";
import {
  BarChart10,
  Building02,
  ChevronDown,
  ChevronRight,
  Columns03,
  ZapSquare,
  CreditCard01,
  Loading01,
  Lock01,
  LogOut01,
  PackageCheck,
  User01,
  Users03,
  Zap,
  Key01,
  HardDrive,
  LinkExternal01,
} from "@untitledui/icons";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
import { useCapabilities, type CapabilityId } from "@/hooks/use-capability";
import { usePendingJoinRequests } from "@/hooks/use-join-requests";
import {
  groupRoutes,
  type SettingsGroupKey,
} from "@/components/settings/settings-tab-groups";
import { useVisibleSettingsTabs } from "@/components/settings/use-settings-tabs";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { Suspense, useState } from "react";
import { useStatusSounds } from "../hooks/use-status-sounds";
import { authClient } from "@/lib/auth-client";
import { track } from "@/lib/posthog-client";
import { clearPersistedQueryCache } from "@/lib/query-persist";
import { Toolbar } from "@/layouts/agent-shell-layout/toolbar";
import {
  MobileSidebarSheet,
  SidebarTriggerButton,
} from "@/layouts/shell-controls";

interface SettingsNavItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  to: string;
  /** Tab group this row fans out into. Visible when any of its tabs is. */
  group?: SettingsGroupKey;
  /** Capability required to see this item. Omitted = visible to every member. */
  requires?: CapabilityId;
  /** Restrict to privileged built-in roles (owner/admin). For screens backed
   *  by owner/admin-only APIs (e.g. role management). */
  privilegedOnly?: boolean;
  /** Count for a small red notification dot on the item (omit / 0 = none). */
  badge?: number;
}

interface SettingsNavGroup {
  /** Stable id for React keys and analytics — never localized. */
  key: string;
  /** Group heading. Empty for the unlabeled account group at the top. */
  label: string;
  /** Rendered behind a disclosure, closed unless it holds the open page. */
  collapsible?: boolean;
  items: SettingsNavItem[];
}

/**
 * The settings sidebar: your account, then the three groups of org screens
 * people work in, then everything rare behind a collapsed "Advanced". Rows that
 * own sibling routes (Connect ⊃ API Keys, Billing ⊃ AI Providers, …) declare a
 * `group` and surface those routes as in-page tabs — see `settings-tab-groups.ts`.
 */
function useSettingsSidebarGroups(): SettingsNavGroup[] {
  const t = useT();
  const { capabilities, isPrivileged, loading, error } = useCapabilities();
  const joinRequestCount = usePendingJoinRequests().length;
  const visibleTabs = useVisibleSettingsTabs();

  const groups: SettingsNavGroup[] = [
    {
      key: "account",
      label: "",
      items: [
        {
          key: "profile",
          label: t("settings.nav.profile"),
          icon: <User01 size={14} />,
          to: "/$org/settings/profile",
        },
      ],
    },
    {
      key: "organization",
      label: t("settings.nav.organization"),
      items: [
        {
          key: "general",
          label: t("settings.nav.general"),
          icon: <Building02 size={14} />,
          to: "/$org/settings/general",
          requires: "org:manage",
        },
        {
          key: "billing",
          label: t("settings.nav.billing"),
          icon: <CreditCard01 size={14} />,
          to: "/$org/settings/billing",
          group: "billing",
        },
        {
          key: "connect",
          label: t("settings.nav.connect"),
          icon: <LinkExternal01 size={14} />,
          to: "/$org/settings/connect",
          group: "connect",
        },
        {
          key: "tasks",
          label: t("settings.nav.tasks"),
          icon: <Columns03 size={14} />,
          to: "/$org/settings/tasks",
          requires: "org:manage",
        },
      ],
    },
    {
      key: "build",
      label: t("settings.nav.build"),
      items: [
        {
          key: "connections",
          label: t("settings.nav.connections"),
          icon: <ZapSquare size={14} />,
          to: "/$org/settings/connections",
        },
        {
          key: "agents",
          label: t("settings.nav.agents"),
          icon: <Users03 size={14} />,
          to: "/$org/settings/agents",
        },
        {
          key: "automations",
          label: t("settings.nav.automations"),
          icon: <Zap size={14} />,
          to: "/$org/settings/automations",
          requires: "automations:manage",
        },
      ],
    },
    {
      key: "manage",
      label: t("settings.nav.manage"),
      items: [
        {
          key: "monitor",
          label: t("settings.nav.monitor"),
          icon: <BarChart10 size={14} />,
          to: "/$org/settings/monitor",
          requires: "monitoring:view",
        },
        {
          key: "members",
          label: t("settings.nav.members"),
          icon: <Users03 size={14} />,
          to: "/$org/settings/members",
          group: "members",
          badge: joinRequestCount,
        },
      ],
    },
    {
      key: "advanced",
      label: t("settings.nav.advanced"),
      collapsible: true,
      items: [
        {
          key: "secrets",
          label: t("settings.nav.secrets"),
          icon: <Key01 size={14} />,
          to: "/$org/settings/secrets",
          requires: "secrets:manage",
        },
        {
          key: "storage",
          label: t("settings.nav.storage"),
          icon: <HardDrive size={14} />,
          to: "/$org/settings/buckets",
          group: "storage",
        },
        {
          key: "store",
          label: t("settings.nav.store"),
          icon: <PackageCheck size={14} />,
          to: "/$org/settings/store",
          requires: "registry:manage",
        },
        {
          key: "sso",
          label: t("settings.nav.security"),
          icon: <Lock01 size={14} />,
          to: "/$org/settings/sso",
          requires: "org:manage",
        },
      ],
    },
  ];

  // While capabilities load — or if the lookup errored — show every item
  // optimistically. This avoids a flicker for the common privileged case and
  // ensures a transient failure never hides nav from owners/admins. Once
  // resolved, hide items the member's role can't open and drop any group left
  // empty. Items without a `requires` (Profile, plugin items) are always shown.
  return groups
    .map((group) => ({
      ...group,
      items: group.items.flatMap((item) => {
        if (item.group) {
          // Route the row at the first tab the member can actually open.
          const [firstTab] = visibleTabs[item.group];
          return firstTab ? [{ ...item, to: firstTab.to }] : [];
        }
        if (loading || error) return [item];
        if (item.privilegedOnly) return isPrivileged ? [item] : [];
        if (!item.requires) return [item];
        return isPrivileged || capabilities[item.requires] ? [item] : [];
      }),
    }))
    .filter((group) => group.items.length > 0);
}

/** Icon with an optional small notification dot, shared by the desktop and mobile nav item rendering. */
function SettingsNavIcon({
  icon,
  badge,
}: {
  icon: React.ReactNode;
  badge?: number;
}) {
  return (
    <span className="relative shrink-0">
      {icon}
      {badge ? (
        <span className="absolute -right-1 -top-1 size-2 rounded-full bg-destructive pointer-events-none" />
      ) : null}
    </span>
  );
}

/**
 * Resolves `$org`-templated `to` paths against the current org/pathname, shared
 * by the desktop and mobile sidebars. Matching is segment-exact, so
 * `/settings/connect` doesn't also light up on `/settings/connections` while a
 * nested `/settings/store/registry` still does.
 */
function useIsActiveSettingsPath() {
  const { org } = useParams({ from: "/shell/$org" });
  const pathname = useRouterState({
    select: (s) => s.location.pathname,
  });

  const matches = (to: string) => {
    const resolved = to.replace("$org", org);
    return pathname === resolved || pathname.startsWith(`${resolved}/`);
  };

  const isActive = (item: SettingsNavItem) =>
    (item.group ? groupRoutes(item.group) : [item.to]).some(matches);

  return { org, isActive };
}

/**
 * Open/closed state for the collapsible groups. A group starts open when it
 * holds the page you're on, so a deep link into Advanced never lands you in a
 * closed drawer.
 */
function useGroupDisclosure() {
  const { isActive } = useIsActiveSettingsPath();
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const isOpen = (group: SettingsNavGroup) =>
    overrides[group.key] ?? (!group.collapsible || group.items.some(isActive));

  const toggle = (group: SettingsNavGroup) =>
    setOverrides((prev) => ({ ...prev, [group.key]: !isOpen(group) }));

  return { isOpen, toggle };
}

/**
 * A group heading — plain text for the fixed groups, a chevron button for the
 * collapsible one.
 */
function SettingsGroupHeading({
  group,
  open,
  onToggle,
  className,
}: {
  group: SettingsNavGroup;
  open: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const style = cn(
    "text-xs font-medium text-muted-foreground/60 truncate",
    className,
  );

  if (!group.collapsible) {
    return <p className={style}>{group.label}</p>;
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn(
        "flex w-full items-center gap-1 rounded-md hover:text-muted-foreground",
        style,
      )}
    >
      {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      <span className="truncate">{group.label}</span>
    </button>
  );
}

export function SettingsSidebar() {
  const t = useT();
  const groups = useSettingsSidebarGroups();
  const { org, isActive } = useIsActiveSettingsPath();
  const { isOpen, toggle } = useGroupDisclosure();

  return (
    <Sidebar variant="sidebar">
      <SidebarContent className="flex flex-col flex-1 mt-2 px-2 pb-2 gap-0 overflow-y-auto">
        {groups.map((group, i) => (
          <SidebarGroup key={group.key} className="pt-0 pr-0 pb-0 pl-0">
            {group.label && (
              <SettingsGroupHeading
                group={group}
                open={isOpen(group)}
                onToggle={() => toggle(group)}
                className={cn("px-2 pt-1.5 pb-0.5", i > 0 && "mt-3")}
              />
            )}
            {isOpen(group) && (
              <SidebarGroupContent>
                <SidebarMenu className="gap-0.5">
                  {group.items.map((item) => (
                    <SidebarMenuItem key={item.key}>
                      <SidebarMenuButton asChild isActive={isActive(item)}>
                        <Link
                          to={item.to}
                          params={{ org }}
                          onClick={() =>
                            // Track stable keys, not labels — labels are localized.
                            track("settings_nav_clicked", {
                              section_key: item.key,
                              group_key: group.key,
                            })
                          }
                          className="flex items-center gap-2.5 text-sm"
                        >
                          <SettingsNavIcon
                            icon={item.icon}
                            badge={item.badge}
                          />
                          <span className="truncate">{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            )}
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
                  <span className="truncate">{t("settings.nav.signOut")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* Version */}
      <div className="mt-auto px-4 pb-1">
        <span className="text-xs text-muted-foreground/50">
          v{__STUDIO_VERSION__}
        </span>
      </div>
    </Sidebar>
  );
}

export function SettingsSidebarMobile({ onClose }: { onClose: () => void }) {
  const t = useT();
  const groups = useSettingsSidebarGroups();
  const { org, isActive } = useIsActiveSettingsPath();
  const { isOpen, toggle } = useGroupDisclosure();

  return (
    <div className="flex flex-col h-full bg-sidebar">
      <div className="flex flex-col flex-1 overflow-y-auto px-2 py-2 gap-0.5">
        {groups.map((group, i) => (
          <div key={group.key} className="flex flex-col gap-0.5">
            {group.label && (
              <SettingsGroupHeading
                group={group}
                open={isOpen(group)}
                onToggle={() => toggle(group)}
                className={cn("px-3 pt-1.5 pb-0.5", i > 0 && "mt-3")}
              />
            )}
            {isOpen(group) &&
              group.items.map((item) => (
                <Link
                  key={item.key}
                  to={item.to}
                  params={{ org }}
                  onClick={onClose}
                  className={cn(
                    "flex items-center gap-3 w-full px-3 py-2.5 rounded-lg transition-colors text-sm",
                    isActive(item)
                      ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                  )}
                >
                  <SettingsNavIcon icon={item.icon} badge={item.badge} />
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
            <span className="truncate">{t("settings.nav.signOut")}</span>
          </button>
        </div>
      </div>

      {/* Version */}
      <div className="px-4 pb-3 pt-1 border-t border-border/50">
        <span className="text-xs text-muted-foreground/50">
          v{__STUDIO_VERSION__}
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
                // Keep in sync with org-shell-layout: 3.125rem → 34px
                // collapsed-rail buttons, matching the expanded toolbar's buttons.
                "--sidebar-width-icon": "3.125rem",
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
