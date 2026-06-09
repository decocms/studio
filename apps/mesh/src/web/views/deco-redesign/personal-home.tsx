// Personal home — the USER's space, above any org (the "chatgpt.com" layer),
// inside the same shell chrome as an Agent (sidebar + toolbar). Mirrors the org
// home (Figma 8243-11524): a brief + New task, important highlights, then
// "Agent updates" (per-Agent groups — the Figma's "Projects updates", renamed),
// and suggestions. Entering an Agent drops into the org experience (/$org).
// Standalone mock at /me (no org / ProjectContext needed).
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  SidebarFooter,
  SidebarInset,
  SidebarLayout,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from "@deco/ui/components/sidebar.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Activity,
  AlertSquare,
  ArrowUpRight,
  Bell01,
  ChevronRight,
  Home01,
  LayoutAlt01,
  Plus,
  SearchSm,
  Stars02,
  Users03,
  Zap,
} from "@untitledui/icons";
import { toast } from "sonner";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import { IntegrationIcon } from "@/web/components/integration-icon";
import { NavigationSidebar } from "@/web/components/sidebar/navigation";
import type {
  NavigationSidebarItem,
  SidebarSection,
} from "@/web/components/sidebar/types";
import { SidebarTriggerButton } from "@/web/layouts/shell-controls";
import { Toolbar } from "@/web/layouts/agent-shell-layout/toolbar";
import { HomeBackground } from "@/web/layouts/home-page/background";
import { SectionLabel } from "./primitives";
import {
  USER,
  USER_AGENTS,
  USER_CONNECTIONS,
  type AgentUpdate,
  type UserAgent,
  type UserConnection,
} from "./mock-user";

export function PersonalHome() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(true);

  // Entering an Agent drops into the real org experience. In production each
  // Agent maps to its own org slug; in the mock they all open the org you last
  // visited so the built /$org experience is one click away.
  const enter = (_agent: UserAgent) => {
    const slug = localStorage.getItem(LOCALSTORAGE_KEYS.lastOrgSlug());
    if (slug) {
      navigate({ to: "/$org", params: { org: slug } });
    } else {
      toast.message("Open a store once first, then your Agents link up here.");
    }
  };

  return (
    <SidebarProvider open={open} onOpenChange={setOpen}>
      <div className="app-shell-root flex h-dvh flex-col overflow-hidden">
        <div className="app-titlebar wco-drag flex h-12 shrink-0 items-center gap-1 bg-sidebar pl-1 pr-2 pt-0.25">
          <Link
            to="/me"
            aria-label="Your space"
            className="wco-no-drag flex shrink-0 items-center pl-1"
          >
            <Toolbar.Logo />
          </Link>
          <SidebarTriggerButton />
        </div>

        <SidebarLayout
          className="relative min-h-0 flex-1 bg-sidebar"
          style={
            {
              "--sidebar-width": "260px",
              "--sidebar-width-icon": "3.5rem",
            } as Record<string, string>
          }
        >
          {!isMobile && <UserSidebar onEnter={enter} />}
          <SidebarInset
            className="flex flex-col"
            style={{ background: "transparent", containerType: "inline-size" }}
          >
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex min-h-0 flex-1 flex-row">
                <div className="min-h-0 flex-1 pb-1 pl-0 pr-1 pt-0">
                  <div className="h-full p-0.5 pt-0.25">
                    <div className="card-shadow relative flex h-full flex-col overflow-hidden rounded-[0.75rem] bg-background">
                      <HomeBackground />
                      <div className="relative min-h-0 flex-1 overflow-y-auto">
                        <PersonalHomeContent onEnter={enter} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </SidebarInset>
        </SidebarLayout>
      </div>
    </SidebarProvider>
  );
}

function UserSidebar({ onEnter }: { onEnter: (agent: UserAgent) => void }) {
  // Same 3-zone shape as the org sidebar (StudioSidebar): top nav, then the
  // "working set" list, then an account footer. Here the working set is your
  // Agents instead of the org's tasks.
  const homeItem: NavigationSidebarItem = {
    key: "home",
    label: "Home",
    icon: <Home01 className="size-4!" />,
    isActive: true,
    onClick: () => {},
  };
  const sections: SidebarSection[] = [{ type: "items", items: [homeItem] }];

  return (
    <NavigationSidebar
      sections={sections}
      footer={<UserAccountFooter />}
      additionalContent={<AgentsList onEnter={onEnter} />}
    />
  );
}

/** The working set: your Agents, styled like the org sidebar's task list. */
function AgentsList({ onEnter }: { onEnter: (agent: UserAgent) => void }) {
  const { state, isMobile } = useSidebar();
  // Collapsed rail shows only nav icons — no list (matches the org sidebar).
  if (state === "collapsed" && !isMobile) return null;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="mb-1 mt-1 flex h-7 shrink-0 items-center gap-1 px-2">
        <span className="text-xs font-medium text-muted-foreground">
          Teammates
        </span>
        <button
          type="button"
          aria-label="Add a teammate"
          onClick={() => toast.message("Add a teammate")}
          className="ml-auto flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <Plus size={14} />
        </button>
      </div>
      <SidebarMenu className="gap-1.5 overflow-y-auto">
        {USER_AGENTS.map((a) => (
          <SidebarMenuItem key={a.id} className="relative">
            <SidebarMenuButton
              onClick={() => onEnter(a)}
              tooltip={a.name}
              className={cn(a.needsReview > 0 && "pr-8")}
            >
              <IntegrationIcon
                icon={a.icon}
                name={a.name}
                size="2xs"
                fallbackIcon={<Users03 size={12} />}
              />
              <span>{a.name}</span>
            </SidebarMenuButton>
            {a.needsReview > 0 && (
              <span className="pointer-events-none absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground group-data-[state=collapsed]/sidebar:hidden">
                {a.needsReview}
              </span>
            )}
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </div>
  );
}

function UserAccountFooter() {
  const { state, isMobile } = useSidebar();
  const collapsed = state === "collapsed" && !isMobile;
  return (
    <SidebarFooter className="p-2">
      <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground">
          {USER.firstName.charAt(0)}
        </span>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-foreground">{USER.name}</div>
            <div className="truncate text-xs text-muted-foreground">
              {USER.email}
            </div>
          </div>
        )}
      </div>
    </SidebarFooter>
  );
}

// ---------------------------------------------------------------------------
// Content (mirrors the org home: brief → highlights → updates → suggestions)
// ---------------------------------------------------------------------------

function PersonalHomeContent({
  onEnter,
}: {
  onEnter: (agent: UserAgent) => void;
}) {
  const reviewTotal = USER_AGENTS.reduce((n, a) => n + a.needsReview, 0);
  const groups = USER_AGENTS.filter((a) => a.updates.length > 0);

  return (
    <div className="mx-auto flex w-full max-w-[900px] flex-col gap-10 px-10 py-10">
      <Greeting reviewTotal={reviewTotal} />

      <Highlights reviewTotal={reviewTotal} />

      <section>
        <SectionLabel>Agent updates</SectionLabel>
        <div className="flex flex-col gap-4">
          {groups.map((a) => (
            <AgentUpdatesGroup
              key={a.id}
              agent={a}
              onEnter={() => onEnter(a)}
            />
          ))}
        </div>
      </section>

      <section>
        <SectionLabel>Your connections</SectionLabel>
        <div className="grid gap-3 sm:grid-cols-2">
          {USER_CONNECTIONS.map((c) => (
            <ConnectionRow key={c.id} connection={c} />
          ))}
        </div>
      </section>

      <section>
        <SectionLabel>Suggestions</SectionLabel>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => toast.message(s.label)}
              className="flex h-40 flex-col justify-between rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-ring/40 hover:bg-accent/30"
            >
              <s.icon size={18} className="text-muted-foreground" />
              <span className="text-sm text-foreground">{s.label}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

const SUGGESTIONS: { label: string; icon: typeof Activity }[] = [
  { label: "Ask about a teammate", icon: Stars02 },
  { label: "Add a teammate", icon: Plus },
  { label: "Connect a tool", icon: Zap },
  { label: "Get a weekly summary", icon: SearchSm },
];

function Greeting({ reviewTotal }: { reviewTotal: number }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">Updated 5m ago</div>
      <p className="mt-4 text-xl leading-snug text-foreground">
        Hi {USER.firstName},
      </p>
      <p className="mt-2 max-w-[60ch] text-lg leading-relaxed text-muted-foreground">
        {reviewTotal > 0
          ? `You have ${reviewTotal} updates in need of review across your teammates. Farm Rio needs the most attention.`
          : "Your teammates are all caught up. Nothing needs your review right now."}
      </p>
      <Button
        size="sm"
        className="mt-5"
        onClick={() => toast.message("New task")}
      >
        <Plus size={16} />
        New task
      </Button>
    </div>
  );
}

function Highlights({ reviewTotal }: { reviewTotal: number }) {
  return (
    <section>
      <SectionLabel>Important highlights</SectionLabel>
      <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-1">
        <div className="flex items-center gap-3 rounded-lg px-3 py-3">
          <Bell01 size={16} className="shrink-0 text-muted-foreground" />
          <span className="text-sm text-foreground">
            {reviewTotal} updates need your approval across your teammates.
          </span>
        </div>
        <div className="flex items-center gap-3 rounded-lg px-3 py-3">
          <AlertSquare size={16} className="shrink-0 text-destructive" />
          <span className="text-sm text-foreground">
            1 critical issue on Farm Rio needs resolving.
          </span>
        </div>
      </div>
    </section>
  );
}

function AgentUpdatesGroup({
  agent,
  onEnter,
}: {
  agent: UserAgent;
  onEnter: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={onEnter}
        className="flex w-full items-center gap-2 border-b border-border px-4 py-2.5 text-left hover:bg-accent/40"
      >
        <IntegrationIcon
          icon={agent.icon}
          name={agent.name}
          size="2xs"
          fallbackIcon={<Users03 size={12} />}
        />
        <span className="text-sm font-medium text-foreground">
          {agent.name}
        </span>
        <span className="text-xs text-muted-foreground">
          {agent.updates.length}
        </span>
        <ChevronRight
          size={14}
          className="ml-auto shrink-0 text-muted-foreground"
        />
      </button>

      <div className="flex flex-col p-1">
        {agent.updates.map((u) => (
          <UpdateRow key={u.id} update={u} onReview={onEnter} />
        ))}
        <button
          type="button"
          onClick={onEnter}
          className="flex items-center gap-1 rounded-lg px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent/40 hover:text-foreground"
        >
          See all
          <ChevronRight size={14} className="ml-auto" />
        </button>
      </div>
    </div>
  );
}

function UpdateRow({
  update,
  onReview,
}: {
  update: AgentUpdate;
  onReview: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-accent/40">
      <LayoutAlt01 size={16} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {update.title}
      </span>
      {update.change && (
        <span className="inline-flex shrink-0 items-center gap-0.5 font-mono text-xs text-muted-foreground">
          {update.change}
          <ArrowUpRight size={11} />
        </span>
      )}
      {update.needsReview ? (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onReview}
        >
          Review
        </Button>
      ) : (
        <span className="shrink-0 text-xs text-success">Done</span>
      )}
    </div>
  );
}

function ConnectionRow({ connection }: { connection: UserConnection }) {
  const [connected, setConnected] = useState(connection.connected);
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
      <IntegrationIcon
        icon={connection.icon}
        name={connection.name}
        size="sm"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {connection.name}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {connection.blurb}
        </p>
      </div>
      {connected ? (
        <span className="shrink-0 text-xs text-success">Connected</span>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => {
            setConnected(true);
            toast.success(`${connection.name} connected.`);
          }}
        >
          <Plus size={14} />
          Connect
        </Button>
      )}
    </div>
  );
}
