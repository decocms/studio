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
  Bell01,
  ZapSquare,
  Loading01,
  LogOut01,
  User01,
} from "@untitledui/icons";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { Suspense } from "react";
import { useStatusSounds } from "../hooks/use-status-sounds";
import { authClient } from "@/web/lib/auth-client";
import { track } from "@/web/lib/posthog-client";
import { clearPersistedQueryCache } from "@/web/lib/query-persist";
import { Toolbar } from "@/web/layouts/agent-shell-layout/toolbar";
import {
  MobileSidebarSheet,
  SidebarTriggerButton,
} from "@/web/layouts/shell-controls";
import { USER_AGENTS } from "@/web/views/deco-redesign/mock-user";

/** The agents shown in the settings sidebar — the current org plus the
 *  other agents the user has (mock). */
function useSidebarAgents(currentName: string, currentLogo: string | null) {
  return [
    { id: "current", name: currentName, logo: currentLogo, current: true },
    ...USER_AGENTS.map((a) => ({
      id: a.id,
      name: a.name,
      logo: a.icon ?? null,
      current: false,
    })),
  ];
}

interface SettingsNavItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  to: string;
}

/**
 * Settings are organized around the teammate model:
 *  - USER scope (top): what belongs to you and carries across every agent —
 *    your connections, profile, and how the teammate notifies you.
 *  - AGENT scope (below): each agent (org-as-teammate) is a single item; its
 *    own config — connections, subagents, knowledge, etc. — lives one level in,
 *    on the agent overview page (`/$org/settings/agent`).
 */
const USER_ITEMS: SettingsNavItem[] = [
  {
    key: "connections",
    label: "Connections",
    icon: <ZapSquare size={14} />,
    to: "/$org/settings/connections",
  },
  {
    key: "profile",
    label: "Profile & Preferences",
    icon: <User01 size={14} />,
    to: "/$org/settings/profile",
  },
  {
    key: "findings",
    label: "Findings & notifications",
    icon: <Bell01 size={14} />,
    to: "/$org/settings/findings",
  },
];

const AGENT_OVERVIEW_TO = "/$org/settings/agent";

function AgentAvatar({ name, logo }: { name: string; logo: string | null }) {
  if (logo) {
    return (
      <img
        src={logo}
        alt=""
        className="size-5 shrink-0 rounded-md border border-border object-cover"
      />
    );
  }
  return (
    <span className="grid size-5 shrink-0 place-items-center rounded-md bg-foreground/10 text-[10px] font-semibold text-foreground">
      {name?.[0]?.toUpperCase() ?? "A"}
    </span>
  );
}

export function SettingsSidebar() {
  const { org } = useParams({ from: "/shell/$org" });
  const { org: organization } = useProjectContext();
  const pathname = useRouterState({
    select: (s) => s.location.pathname,
  });

  const isActive = (to: string) => {
    const resolved = to.replace("$org", org);
    return pathname.startsWith(resolved);
  };

  // Any settings path that isn't a user-scoped page belongs to the agent, so
  // the active agent stays highlighted while you're deep in its sub-pages.
  const userActive = USER_ITEMS.some((item) => isActive(item.to));
  const agentActive = !userActive && pathname.includes("/settings");
  const agents = useSidebarAgents(organization.name, organization.logo);
  const activeAgentId = useRouterState({
    select: (s) => (s.location.search as { agent?: string }).agent ?? "current",
  });

  return (
    <Sidebar variant="sidebar">
      <SidebarContent className="flex flex-col flex-1 mt-2 px-2 pb-2 gap-0 overflow-y-auto">
        {/* User scope */}
        <SidebarGroup className="pt-0 pr-0 pb-0 pl-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {USER_ITEMS.map((item) => (
                <SidebarMenuItem key={item.key}>
                  <SidebarMenuButton asChild isActive={isActive(item.to)}>
                    <Link
                      to={item.to}
                      params={{ org }}
                      onClick={() =>
                        track("settings_nav_clicked", {
                          section_key: item.key,
                          section_label: item.label,
                          group_label: "user",
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

        {/* Agent scope — each agent is one item; its config lives one level in */}
        <div className="mx-2 my-2 border-t border-border/50" />
        <SidebarGroup className="pt-0 pr-0 pb-0 pl-0">
          <p className="px-2 pt-1.5 pb-0.5 text-xs font-medium text-muted-foreground/60">
            Agents
          </p>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {agents.map((agent) => (
                <SidebarMenuItem key={agent.id}>
                  <SidebarMenuButton
                    asChild
                    isActive={agentActive && agent.id === activeAgentId}
                  >
                    <Link
                      to={AGENT_OVERVIEW_TO}
                      params={{ org }}
                      search={agent.current ? {} : { agent: agent.id }}
                      onClick={() =>
                        track("settings_nav_clicked", {
                          section_key: "agent",
                          section_label: agent.name,
                          group_label: "agents",
                        })
                      }
                      className="flex items-center gap-2.5 text-sm"
                    >
                      <AgentAvatar name={agent.name} logo={agent.logo} />
                      <span className="truncate">{agent.name}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

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
  const { org } = useParams({ from: "/shell/$org" });
  const { org: organization } = useProjectContext();
  const pathname = useRouterState({
    select: (s) => s.location.pathname,
  });

  const isActive = (to: string) => {
    const resolved = to.replace("$org", org);
    return pathname.startsWith(resolved);
  };

  const userActive = USER_ITEMS.some((item) => isActive(item.to));
  const agentActive = !userActive && pathname.includes("/settings");
  const agents = useSidebarAgents(organization.name, organization.logo);
  const activeAgentId = useRouterState({
    select: (s) => (s.location.search as { agent?: string }).agent ?? "current",
  });

  const rowBase =
    "flex items-center gap-3 w-full px-3 py-2.5 rounded-lg transition-colors text-sm";
  const rowOn = "bg-sidebar-accent text-sidebar-accent-foreground font-medium";
  const rowOff =
    "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground";

  return (
    <div className="flex flex-col h-full bg-sidebar">
      <div className="flex flex-col flex-1 overflow-y-auto px-2 py-2 gap-0.5">
        {/* User scope */}
        {USER_ITEMS.map((item) => (
          <Link
            key={item.key}
            to={item.to}
            params={{ org }}
            onClick={onClose}
            className={cn(rowBase, isActive(item.to) ? rowOn : rowOff)}
          >
            <span className="shrink-0">{item.icon}</span>
            <span className="truncate">{item.label}</span>
          </Link>
        ))}

        {/* Agent scope */}
        <div className="mx-3 my-2 border-t border-border/50" />
        <p className="px-3 pt-1.5 pb-0.5 text-xs font-medium text-muted-foreground/60">
          Agents
        </p>
        {agents.map((agent) => (
          <Link
            key={agent.id}
            to={AGENT_OVERVIEW_TO}
            params={{ org }}
            search={agent.current ? {} : { agent: agent.id }}
            onClick={onClose}
            className={cn(
              rowBase,
              agentActive && agent.id === activeAgentId ? rowOn : rowOff,
            )}
          >
            <AgentAvatar name={agent.name} logo={agent.logo} />
            <span className="truncate">{agent.name}</span>
          </Link>
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
