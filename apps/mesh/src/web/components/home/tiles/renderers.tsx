/**
 * Tile renderers. Each tile reads from real Studio sources — no mock
 * data lives here. Tiles attributed to "Studio Agent" (recent tasks,
 * connections, workspace stats) read from the same hooks the rest of
 * the app uses; user content (notes) reads from localStorage.
 */

import type { ReactNode } from "react";
import { authClient } from "@/web/lib/auth-client";
import { useNavigate } from "@tanstack/react-router";
import {
  useConnections,
  useProjectContext,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useLocalStorage } from "@/web/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import { AgentAvatar } from "@/web/components/agent-icon";
import { IntegrationIcon } from "@/web/components/integration-icon";
import { useTasks } from "@/web/components/chat/task/use-task-manager";
import { AppViewContent } from "@/web/routes/project-app-view";
import { getStatusConfig } from "@/web/lib/task-status";
import { useAgentRecruit } from "./agent-recruit-provider";
import { STUDIO_AGENT, type AgentSeedId } from "./agent-seeds";
import { useTileConfigUpdate } from "./tile-config-update-context";
import {
  Activity,
  AlignLeft,
  ArrowRight,
  BookOpen01,
  Columns01,
  MessageCircle01,
  Server01,
  Star01,
  Stars01,
  Tool01,
  Users03,
  Zap,
} from "@untitledui/icons";
import type { TileRenderProps } from "./types";

interface AgentIdentity {
  icon: string;
  name: string;
}

/**
 * Frame shared by every agent-attributed tile (Studio Agent's data
 * views and the agent.card type). Mirrors the agent-card layout:
 *   row 1 — agent avatar + optional action chip
 *   row 2 — agent name eyebrow (small muted) + view title (primary)
 *   row 3 — body
 *
 * `eyebrow` lets agent.card tiles suppress the redundant "Image
 * Creator / Image Creator" pair when the view title is just the
 * agent name.
 */
function AgentTileFrame({
  agent,
  title,
  eyebrow,
  action,
  children,
}: {
  agent: AgentIdentity;
  title: string;
  eyebrow?: string | false;
  action?: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  const showEyebrow = eyebrow !== false;
  const eyebrowText = typeof eyebrow === "string" ? eyebrow : agent.name;
  return (
    <div className="flex h-full flex-col p-5 gap-4 min-h-0">
      <div className="flex items-center justify-between gap-3 shrink-0">
        <AgentAvatar icon={agent.icon} name={agent.name} size="sm+" />
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            {action.label}
            <ArrowRight size={12} />
          </button>
        )}
      </div>
      <div className="flex flex-col gap-0.5 shrink-0 min-w-0">
        {showEyebrow && (
          <p className="text-[11px] text-muted-foreground tracking-tight truncate">
            {eyebrowText}
          </p>
        )}
        <p className="text-[15px] font-medium text-foreground tracking-tight leading-tight truncate">
          {title}
        </p>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
    </div>
  );
}

/** Frame for system tiles that don't belong to an agent. */
function SystemTileFrame({
  title,
  icon,
  action,
  children,
}: {
  title: string;
  icon: ReactNode;
  action?: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col p-5 gap-5 min-h-0">
      <div className="flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex size-7 items-center justify-center rounded-md bg-background text-muted-foreground shrink-0 border border-border/60">
            {icon}
          </span>
          <span className="text-[13px] font-medium text-foreground/90 truncate tracking-tight">
            {title}
          </span>
        </div>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            {action.label}
            <ArrowRight size={12} />
          </button>
        )}
      </div>
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
    </div>
  );
}

/**
 * Compact frame for tiles attributed to an agent that have content
 * (lists, stats, charts, embedded UIs). The avatar is inline with the
 * view title so the body has maximum room. Use AgentTileFrame instead
 * for content-less agent.card tiles where the agent IS the content.
 */
function AgentDataTileFrame({
  agent,
  title,
  action,
  children,
}: {
  agent: AgentIdentity;
  title: string;
  action?: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col p-5 gap-5 min-h-0">
      <div className="flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <AgentAvatar icon={agent.icon} name={agent.name} size="xs" />
          <span className="text-[13px] font-medium text-foreground/90 truncate tracking-tight">
            {title}
          </span>
        </div>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            {action.label}
            <ArrowRight size={12} />
          </button>
        )}
      </div>
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
    </div>
  );
}

function EmptyBody({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center text-center text-xs leading-relaxed text-muted-foreground/70 px-2">
      {children}
    </div>
  );
}

/* ---------- studio.welcome ---------- */

export function WelcomeTile({ instance: _instance }: TileRenderProps) {
  const { data: session } = authClient.useSession();
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const userName = session?.user?.name?.split(" ")[0] || "there";

  const actions = [
    {
      label: "Start a chat",
      icon: <MessageCircle01 size={14} />,
      primary: true,
      onClick: () => {
        const taskId = crypto.randomUUID();
        navigate({ to: "/$org/$taskId", params: { org: org.slug, taskId } });
      },
    },
    {
      label: "Browse agents",
      icon: <Users03 size={14} />,
      primary: false,
      onClick: () =>
        navigate({ to: "/$org/settings/agents", params: { org: org.slug } }),
    },
    {
      label: "Connections",
      icon: <Server01 size={14} />,
      primary: false,
      onClick: () =>
        navigate({
          to: "/$org/settings/connections",
          params: { org: org.slug },
        }),
    },
  ];

  return (
    <div className="relative flex h-full items-center justify-between gap-8 overflow-hidden px-8 py-6">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-primary/15 via-primary/5 to-transparent" />
      <div className="pointer-events-none absolute right-6 top-1/2 -translate-y-1/2 text-primary opacity-[0.07]">
        <Stars01 size={96} />
      </div>
      <div className="relative flex flex-col gap-2 min-w-0">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Stars01 size={11} />
          <span>Welcome back</span>
        </div>
        <h2 className="text-2xl font-semibold text-foreground truncate">
          Hello, {userName}.
        </h2>
        <p className="text-xs text-muted-foreground max-w-sm leading-relaxed">
          Pin the things you check every day. Drop tiles from agents and apps
          you've connected.
        </p>
      </div>
      <div className="relative flex items-center gap-2 shrink-0">
        {actions.map((a) => (
          <Button
            key={a.label}
            variant={a.primary ? "default" : "outline"}
            size="sm"
            onClick={a.onClick}
            className="gap-1.5"
          >
            {a.icon}
            {a.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

/* ---------- studio.recent-agents (real virtual MCPs) ---------- */

const RECENT_AGENT_LIMIT = 6;

export function RecentAgentsTile(_props: TileRenderProps) {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const allAgents = useVirtualMCPs();
  const recent = allAgents
    .filter((a) => a.status === "active")
    .slice(0, RECENT_AGENT_LIMIT);

  return (
    <AgentDataTileFrame
      agent={STUDIO_AGENT}
      title="Recent agents"
      action={{
        label: "All",
        onClick: () =>
          navigate({ to: "/$org/settings/agents", params: { org: org.slug } }),
      }}
    >
      {recent.length === 0 ? (
        <EmptyBody>No agents yet.</EmptyBody>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {recent.map((a) => (
            <li key={a.id} className="border-b border-border/30 last:border-0">
              <button
                type="button"
                className="group flex w-full items-center gap-3 px-2 py-2.5 text-left transition-colors hover:bg-muted/60"
                onClick={() => {
                  const taskId = crypto.randomUUID();
                  navigate({
                    to: "/$org/$taskId",
                    params: { org: org.slug, taskId },
                    search: { virtualmcpid: a.id },
                  });
                }}
              >
                <AgentAvatar icon={a.icon} name={a.title} size="xs" />
                <span className="flex-1 truncate text-[13px] font-medium text-foreground">
                  {a.title}
                </span>
                <ArrowRight
                  size={11}
                  className="shrink-0 text-transparent transition-colors group-hover:text-muted-foreground"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </AgentDataTileFrame>
  );
}

/* ---------- studio.recent-tasks (real threads) ---------- */

const RECENT_TASK_LIMIT = 5;
const TASKS_PER_COLUMN = 4;
const KANBAN_STATUS_ORDER = [
  "requires_action",
  "in_progress",
  "failed",
  "expired",
] as const;

function kanbanDot(status: string): string {
  switch (status) {
    case "requires_action":
      return "bg-orange-500";
    case "in_progress":
      return "bg-blue-500";
    case "failed":
      return "bg-red-500";
    case "expired":
      return "bg-amber-500";
    default:
      return "bg-muted-foreground/40";
  }
}

export function RecentTasksTile({ instance, isEditMode }: TileRenderProps) {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const updateConfig = useTileConfigUpdate();

  const view = (instance.config?.view as "list" | "kanban") ?? "list";
  const isKanban = view === "kanban";

  const { tasks } = useTasks({
    owner: "me",
    status: "open",
    userId: session?.user?.id,
  });

  const toggleView = (next: "list" | "kanban") => {
    updateConfig?.(instance.id, { view: next });
  };

  const openTask = (taskId: string) =>
    navigate({ to: "/$org/$taskId", params: { org: org.slug, taskId } });

  const listItems = tasks.slice(0, RECENT_TASK_LIMIT);

  const columns = KANBAN_STATUS_ORDER.map((status) => ({
    status,
    config: getStatusConfig(status),
    tasks: tasks.filter((t) => t.status === status).slice(0, TASKS_PER_COLUMN),
  })).filter((col) => col.tasks.length > 0);

  return (
    <AgentDataTileFrame agent={STUDIO_AGENT} title="Recent tasks">
      {isEditMode && (
        <div className="mb-3 flex items-center">
          <div className="inline-flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5">
            <button
              type="button"
              onClick={() => toggleView("list")}
              className={cn(
                "flex h-5 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors",
                !isKanban
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <AlignLeft size={11} />
              List
            </button>
            <button
              type="button"
              onClick={() => toggleView("kanban")}
              className={cn(
                "flex h-5 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors",
                isKanban
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Columns01 size={11} />
              Kanban
            </button>
          </div>
        </div>
      )}

      {!isKanban ? (
        listItems.length === 0 ? (
          <EmptyBody>No tasks yet — start a chat to begin one.</EmptyBody>
        ) : (
          <ul className="-mx-2 flex flex-col">
            {listItems.map((t) => {
              const config = getStatusConfig(t.status);
              const StatusIcon = config.icon;
              return (
                <li
                  key={t.id}
                  className="border-b border-border/30 last:border-0"
                >
                  <button
                    type="button"
                    onClick={() => openTask(t.id)}
                    className="flex w-full items-center gap-2.5 px-2 py-2.5 text-left transition-colors hover:bg-muted/60"
                  >
                    <StatusIcon
                      size={12}
                      className={cn("shrink-0", config.iconClassName)}
                    />
                    <span className="flex-1 truncate text-[13px] text-foreground">
                      {t.title}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 text-[11px] font-medium",
                        config.labelColor,
                      )}
                    >
                      {config.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )
      ) : columns.length === 0 ? (
        <EmptyBody>No tasks yet — start a chat to begin one.</EmptyBody>
      ) : (
        <div
          className={cn(
            "flex-1 min-h-0 overflow-y-auto",
            instance.w >= 2
              ? "grid grid-cols-2 gap-3 content-start"
              : "flex flex-col gap-4",
          )}
        >
          {columns.map((col) => (
            <div key={col.status} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    kanbanDot(col.status),
                  )}
                />
                <span className="text-[11px] font-medium text-muted-foreground">
                  {col.config.label}
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground/50">
                  {col.tasks.length}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                {col.tasks.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => openTask(t.id)}
                    className="truncate rounded-md border border-border/40 bg-background/60 px-2 py-1.5 text-left text-[12px] text-foreground leading-snug transition-colors hover:bg-muted/60"
                  >
                    {t.title}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </AgentDataTileFrame>
  );
}

/* ---------- studio.connections-overview (real connections) ---------- */

const CONNECTION_PREVIEW_LIMIT = 8;

export function ConnectionsOverviewTile(_props: TileRenderProps) {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const connections = useConnections();
  const total = connections.length;
  const active = connections.filter((c) => c.status === "active").length;
  const error = connections.filter((c) => c.status === "error").length;
  const inactive = total - active - error;
  const preview = connections.slice(0, CONNECTION_PREVIEW_LIMIT);

  return (
    <AgentDataTileFrame
      agent={STUDIO_AGENT}
      title="Connections"
      action={{
        label: "Manage",
        onClick: () =>
          navigate({
            to: "/$org/settings/connections",
            params: { org: org.slug },
          }),
      }}
    >
      <div className="flex flex-1 min-h-0 flex-col justify-between gap-4">
        <div className="flex items-baseline gap-6">
          <Stat label="Active" value={active} tone="ok" />
          <Stat label="Inactive" value={inactive} tone="muted" />
          <Stat label="Errors" value={error} tone="bad" />
        </div>
        {preview.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {preview.map((c) => (
              <span
                key={c.id}
                title={c.title}
                className="size-8 shrink-0 overflow-hidden rounded-lg border border-border/60 bg-background shadow-sm"
              >
                <IntegrationIcon
                  icon={c.icon ?? undefined}
                  name={c.title}
                  size="xs"
                  className="rounded-none border-0"
                />
              </span>
            ))}
          </div>
        ) : (
          <EmptyBody>No connections yet</EmptyBody>
        )}
      </div>
    </AgentDataTileFrame>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "ok" | "bad" | "muted";
}) {
  const valueColor =
    tone === "ok"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "bad" && value > 0
        ? "text-rose-600 dark:text-rose-400"
        : "text-foreground";
  const dot =
    tone === "ok"
      ? "bg-emerald-500"
      : tone === "bad"
        ? "bg-rose-500"
        : "bg-muted-foreground/40";
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span
        className={cn(
          "text-2xl font-semibold leading-none tabular-nums tracking-tight",
          valueColor,
        )}
      >
        {value}
      </span>
      <div className="flex items-center gap-1.5">
        <span className={cn("size-1.5 shrink-0 rounded-full", dot)} />
        <span className="text-[11px] text-muted-foreground">{label}</span>
      </div>
    </div>
  );
}

/* ---------- studio.shortcuts ---------- */

type ShortcutId = "agents" | "connections" | "monitor" | "general";

const DEFAULT_SHORTCUTS: {
  id: ShortcutId;
  label: string;
  icon: ReactNode;
  iconBg: string;
  iconColor: string;
}[] = [
  {
    id: "agents",
    label: "Agents",
    icon: <Users03 size={15} />,
    iconBg: "bg-violet-100 dark:bg-violet-900/40",
    iconColor: "text-violet-600 dark:text-violet-400",
  },
  {
    id: "connections",
    label: "Connections",
    icon: <Server01 size={15} />,
    iconBg: "bg-sky-100 dark:bg-sky-900/40",
    iconColor: "text-sky-600 dark:text-sky-400",
  },
  {
    id: "monitor",
    label: "Monitor",
    icon: <Activity size={15} />,
    iconBg: "bg-amber-100 dark:bg-amber-900/40",
    iconColor: "text-amber-600 dark:text-amber-400",
  },
  {
    id: "general",
    label: "Settings",
    icon: <Tool01 size={15} />,
    iconBg: "bg-muted",
    iconColor: "text-muted-foreground",
  },
];

export function ShortcutsTile(_props: TileRenderProps) {
  const navigate = useNavigate();
  const { org } = useProjectContext();

  const goTo = (id: ShortcutId) => {
    switch (id) {
      case "agents":
        navigate({ to: "/$org/settings/agents", params: { org: org.slug } });
        return;
      case "connections":
        navigate({
          to: "/$org/settings/connections",
          params: { org: org.slug },
        });
        return;
      case "monitor":
        navigate({ to: "/$org/settings/monitor", params: { org: org.slug } });
        return;
      case "general":
        navigate({ to: "/$org/settings/general", params: { org: org.slug } });
        return;
      default: {
        const _exhaustive: never = id;
        return _exhaustive;
      }
    }
  };

  return (
    <SystemTileFrame title="Shortcuts" icon={<Star01 size={14} />}>
      <div className="grid grid-cols-2 grid-rows-2 gap-2 flex-1 min-h-0">
        {DEFAULT_SHORTCUTS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => goTo(s.id)}
            className="flex h-full flex-col items-start justify-between gap-3 rounded-lg border border-border/50 bg-background p-4 text-left transition-colors hover:border-primary/30 hover:bg-muted/40 min-h-0"
          >
            <span
              className={cn(
                "flex size-8 items-center justify-center rounded-md",
                s.iconBg,
                s.iconColor,
              )}
            >
              {s.icon}
            </span>
            <span className="text-[13px] font-medium text-foreground">
              {s.label}
            </span>
          </button>
        ))}
      </div>
    </SystemTileFrame>
  );
}

/* ---------- studio.notes ---------- */

export function NotesTile({ instance: _instance }: TileRenderProps) {
  const { data: session } = authClient.useSession();
  const { org } = useProjectContext();
  const [text, setText] = useLocalStorage<string>(
    LOCALSTORAGE_KEYS.homeNotes(org.slug, session?.user?.id ?? "anon"),
    () => "",
  );

  return (
    <SystemTileFrame title="Notes" icon={<BookOpen01 size={14} />}>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Quick notes…"
        className="flex-1 resize-none rounded-lg border border-border/50 bg-background/60 text-[13px] leading-relaxed focus-visible:ring-1 focus-visible:ring-primary/25 focus-visible:ring-offset-0 placeholder:text-muted-foreground/50"
      />
    </SystemTileFrame>
  );
}

/* ---------- studio.stats (real workspace stats) ---------- */

export function StatsTile(_props: TileRenderProps) {
  const connections = useConnections();
  const agents = useVirtualMCPs();
  const activeConnections = connections.filter(
    (c) => c.status === "active",
  ).length;
  const activeAgents = agents.filter((a) => a.status === "active").length;
  const erroredConnections = connections.filter(
    (c) => c.status === "error",
  ).length;
  const totalAgents = agents.length;

  const cards: { label: string; value: number; valueClass: string }[] = [
    {
      label: "Active agents",
      value: activeAgents,
      valueClass: "text-emerald-600 dark:text-emerald-400",
    },
    {
      label: "All agents",
      value: totalAgents,
      valueClass: "text-foreground",
    },
    {
      label: "Connections",
      value: activeConnections,
      valueClass: "text-sky-600 dark:text-sky-400",
    },
    {
      label: "Errors",
      value: erroredConnections,
      valueClass:
        erroredConnections > 0
          ? "text-rose-600 dark:text-rose-400"
          : "text-foreground",
    },
  ];

  return (
    <AgentDataTileFrame agent={STUDIO_AGENT} title="Workspace stats">
      <div className="grid grid-cols-2 grid-rows-2 gap-x-6 gap-y-4 flex-1 min-h-0">
        {cards.map((s) => (
          <div key={s.label} className="flex min-h-0 flex-col gap-1.5">
            <span
              className={cn(
                "text-2xl font-semibold leading-none tabular-nums tracking-tight",
                s.valueClass,
              )}
            >
              {s.value}
            </span>
            <span className="truncate text-[11px] text-muted-foreground">
              {s.label}
            </span>
          </div>
        ))}
      </div>
    </AgentDataTileFrame>
  );
}

/* ---------- agent.card ---------- */

interface AgentCardConfig {
  templateId?: string;
  agentId?: string;
  title?: string;
  description?: string;
  icon?: string;
}

export function AgentCardTile({ instance }: TileRenderProps) {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const recruit = useAgentRecruit();
  const config = (instance.config ?? {}) as AgentCardConfig;
  const title = config.title ?? "Agent";
  const description = config.description;
  const icon = config.icon ?? "";
  const templateId = config.templateId as AgentSeedId | undefined;
  const customAgentId = config.agentId;

  const hasBody = instance.h >= 2 || instance.w >= 2;

  const handleClick = () => {
    // Custom virtual MCP that the user already owns — open its thread.
    if (customAgentId && !templateId) {
      const taskId = crypto.randomUUID();
      navigate({
        to: "/$org/$taskId",
        params: { org: org.slug, taskId },
        search: { virtualmcpid: customAgentId },
      });
      return;
    }
    // Well-known template: hand off to the recruit provider, which
    // either opens the matching install dialog or, if the template is
    // already installed, navigates to its existing thread.
    if (templateId && recruit) {
      recruit.openAgent(templateId, title);
      return;
    }
    // Fallback (shouldn't happen on the home today): open a fresh chat.
    const taskId = crypto.randomUUID();
    navigate({
      to: "/$org/$taskId",
      params: { org: org.slug, taskId },
    });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="group relative h-full w-full overflow-hidden text-left"
      aria-label={`Open ${title}`}
    >
      <div className="pointer-events-none absolute inset-0 bg-primary/5 opacity-0 transition-opacity group-hover:opacity-100" />
      <AgentTileFrame
        agent={{ icon, name: title }}
        title={title}
        eyebrow={false}
      >
        {hasBody && description && (
          <p className="text-[12px] text-muted-foreground line-clamp-3 leading-snug">
            {description}
          </p>
        )}
      </AgentTileFrame>
    </button>
  );
}

/* ---------- agent.tool-view ---------- */

/**
 * A tile that renders a specific tool view exposed by an installed
 * agent (entries from `metadata.ui.layout.tabs` or `metadata.ui.pinnedViews`).
 * The body uses AppViewContent — the same renderer the chat surface
 * uses for these tabs — so the user sees the agent's actual UI inline.
 * Header carries an "Open" action that navigates to the full view.
 */
interface AgentToolViewConfig {
  agentId?: string;
  agentTitle?: string;
  agentIcon?: string;
  /** "tab:<id>" or "app:<connectionId>:<toolName>" — used by the
   *  Open action to land on the right tab in the chat surface. */
  mainTabId?: string;
  viewLabel?: string;
  viewIcon?: string;
  /** Resolves the actual tool to render inline. */
  connectionId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
}

interface AgentLayoutTab {
  id: string;
  title?: string;
  view?: { appId?: string; args?: Record<string, unknown> };
}

interface AgentMetadataShape {
  ui?: {
    layout?: { tabs?: AgentLayoutTab[] | undefined } | null;
  } | null;
}

/**
 * Tiles pinned before connectionId / toolName were stored on config
 * carry only `mainTabId`. Derive what we can from that + the agent's
 * live metadata so existing pins keep rendering after the upgrade.
 */
function resolveToolTarget(
  config: AgentToolViewConfig,
  agentMeta: AgentMetadataShape | undefined,
): {
  connectionId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
} {
  if (config.connectionId && config.toolName) {
    return {
      connectionId: config.connectionId,
      toolName: config.toolName,
      args: config.args,
    };
  }
  const tabId = config.mainTabId;
  if (!tabId) return {};
  if (tabId.startsWith("app:")) {
    const rest = tabId.slice("app:".length);
    const sep = rest.indexOf(":");
    if (sep > 0) {
      return {
        connectionId: rest.slice(0, sep),
        toolName: rest.slice(sep + 1),
      };
    }
    return {};
  }
  const tab = agentMeta?.ui?.layout?.tabs?.find((t) => t?.id === tabId);
  if (tab?.view?.appId) {
    return {
      connectionId: tab.view.appId,
      toolName: tab.id,
      args: tab.view.args,
    };
  }
  return {};
}

export function AgentToolViewTile({ instance }: TileRenderProps) {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const config = (instance.config ?? {}) as AgentToolViewConfig;
  const agentTitle = config.agentTitle ?? "Agent";
  const agentIcon = config.agentIcon ?? "";
  const viewLabel = config.viewLabel ?? "View";
  const refId = config.agentId;

  const agents = useVirtualMCPs();
  const agentMeta = refId
    ? (agents.find((a) => a.id === refId)?.metadata as
        | AgentMetadataShape
        | undefined)
    : undefined;
  const { connectionId, toolName, args } = resolveToolTarget(config, agentMeta);

  const openInChat = () => {
    if (!refId) return;
    const taskId = crypto.randomUUID();
    navigate({
      to: "/$org/$taskId",
      params: { org: org.slug, taskId },
      search: {
        virtualmcpid: refId,
        ...(config.mainTabId ? { main: config.mainTabId } : {}),
      } as never,
    });
  };

  return (
    <AgentDataTileFrame
      agent={{ icon: agentIcon, name: agentTitle }}
      title={viewLabel}
      action={refId ? { label: "Open", onClick: openInChat } : undefined}
    >
      {connectionId && toolName ? (
        <div className="flex-1 min-h-0 -mx-3 -mb-3 rounded-xl overflow-hidden bg-background border border-border/60">
          <AppViewContent
            connectionId={connectionId}
            toolName={toolName}
            args={args}
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <div className="flex size-9 items-center justify-center rounded-xl border border-border/60 bg-background text-muted-foreground">
            <ArrowRight size={15} />
          </div>
          <p className="text-[12px] text-muted-foreground leading-snug">
            Open {viewLabel.toLowerCase()}
          </p>
        </div>
      )}
    </AgentDataTileFrame>
  );
}

/* ---------- unknown ---------- */

export function UnknownTile({ instance }: TileRenderProps) {
  return (
    <SystemTileFrame title="Unknown tile" icon={<Zap size={14} />}>
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center">
        <p className="text-sm text-muted-foreground">
          Tile type <code className="text-foreground">{instance.type}</code>{" "}
          isn't installed.
        </p>
      </div>
    </SystemTileFrame>
  );
}

/* ---------- skeletons / loading ---------- */

export function TileSkeleton() {
  return (
    <div className="flex h-full flex-col p-5 gap-4">
      <div className="flex items-center gap-2">
        <Skeleton className="size-6 rounded-md" />
        <Skeleton className="h-3 w-24" />
      </div>
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}
