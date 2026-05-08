/**
 * Tile renderers. Each tile reads from real Studio sources — no mock
 * data lives here. Tiles attributed to "Studio Agent" (recent tasks,
 * connections, workspace stats) read from the same hooks the rest of
 * the app uses; user content (notes) reads from localStorage.
 */

import type { ReactNode } from "react";
import { useState } from "react";
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
import { getStatusConfig } from "@/web/lib/task-status";
import {
  Activity,
  ArrowRight,
  BookOpen01,
  Clock,
  Lightning01,
  MessageCircle01,
  Server01,
  Star01,
  Stars01,
  Tool01,
  TrendUp02,
  Users03,
  Zap,
} from "@untitledui/icons";
import type { TileRenderProps } from "./types";

function TileFrame({
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

function EmptyBody({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 flex items-center justify-center text-center text-xs text-muted-foreground">
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
      onClick: () => {
        const taskId = crypto.randomUUID();
        navigate({ to: "/$org/$taskId", params: { org: org.slug, taskId } });
      },
    },
    {
      label: "Browse agents",
      icon: <Users03 size={14} />,
      onClick: () =>
        navigate({ to: "/$org/settings/agents", params: { org: org.slug } }),
    },
    {
      label: "Connections",
      icon: <Server01 size={14} />,
      onClick: () =>
        navigate({
          to: "/$org/settings/connections",
          params: { org: org.slug },
        }),
    },
  ];

  return (
    <div className="flex h-full items-center justify-between gap-8 p-6 bg-gradient-to-br from-primary/5 via-background to-background rounded-[0.75rem]">
      <div className="flex flex-col gap-2 min-w-0">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Stars01 size={12} />
          <span>Welcome back</span>
        </div>
        <h2 className="text-xl font-medium text-foreground truncate">
          Hello, {userName}.
        </h2>
        <p className="text-xs text-muted-foreground max-w-md">
          Pin the things you check every day. Drop tiles from agents and apps
          you've connected.
        </p>
      </div>
      <div className="flex flex-wrap gap-2 shrink-0">
        {actions.map((a) => (
          <Button
            key={a.label}
            variant="outline"
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
    <TileFrame
      title="Recent agents"
      icon={<Users03 size={14} />}
      action={{
        label: "All",
        onClick: () =>
          navigate({ to: "/$org/settings/agents", params: { org: org.slug } }),
      }}
    >
      {recent.length === 0 ? (
        <EmptyBody>No agents yet.</EmptyBody>
      ) : (
        <ul className="flex flex-col gap-0.5 -mx-2">
          {recent.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className="flex items-center gap-3 w-full px-2 py-2 rounded-md hover:bg-muted transition-colors text-left"
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
                <span className="text-sm text-foreground truncate flex-1">
                  {a.title}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </TileFrame>
  );
}

/* ---------- studio.recent-tasks (real threads) ---------- */

const RECENT_TASK_LIMIT = 5;

export function RecentTasksTile(_props: TileRenderProps) {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const { tasks } = useTasks({
    owner: "me",
    status: "open",
    userId: session?.user?.id,
  });
  const recent = tasks.slice(0, RECENT_TASK_LIMIT);

  return (
    <TileFrame title="Recent tasks" icon={<Clock size={14} />}>
      {recent.length === 0 ? (
        <EmptyBody>No tasks yet — start a chat to begin one.</EmptyBody>
      ) : (
        <ul className="flex flex-col gap-3">
          {recent.map((t) => {
            const config = getStatusConfig(t.status);
            const StatusIcon = config.icon;
            return (
              <li key={t.id} className="flex items-center gap-2.5 min-w-0">
                <StatusIcon
                  size={12}
                  className={cn("shrink-0", config.iconClassName)}
                />
                <button
                  type="button"
                  onClick={() =>
                    navigate({
                      to: "/$org/$taskId",
                      params: { org: org.slug, taskId: t.id },
                    })
                  }
                  className="text-[13px] text-foreground truncate flex-1 text-left hover:underline"
                >
                  {t.title}
                </button>
                <span className={cn("text-[11px] shrink-0", config.labelColor)}>
                  {config.label}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </TileFrame>
  );
}

/* ---------- studio.quick-chat ---------- */

export function QuickChatTile(_props: TileRenderProps) {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const [draft, setDraft] = useState("");

  const submit = () => {
    if (!draft.trim()) return;
    const taskId = crypto.randomUUID();
    navigate({
      to: "/$org/$taskId",
      params: { org: org.slug, taskId },
      search: { autosend: draft } as never,
    });
  };

  return (
    <TileFrame title="Quick chat" icon={<Lightning01 size={14} />}>
      <div className="flex flex-col gap-3 flex-1 min-h-0">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="What's on your mind?"
          className="flex-1 resize-none min-h-0 text-sm"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
        />
        <div className="flex items-center justify-between shrink-0">
          <span className="text-[10px] text-muted-foreground">
            ⌘ + Enter to send
          </span>
          <Button
            size="sm"
            onClick={submit}
            disabled={!draft.trim()}
            className="gap-1 h-7"
          >
            Send
            <ArrowRight size={12} />
          </Button>
        </div>
      </div>
    </TileFrame>
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
    <TileFrame
      title="Connections"
      icon={<Server01 size={14} />}
      action={{
        label: "Manage",
        onClick: () =>
          navigate({
            to: "/$org/settings/connections",
            params: { org: org.slug },
          }),
      }}
    >
      <div className="flex flex-col gap-5 flex-1 min-h-0 justify-between">
        <div className="flex items-baseline gap-5">
          <Stat label="Active" value={active} tone="ok" />
          <Stat label="Inactive" value={inactive} tone="muted" />
          <Stat label="Errors" value={error} tone="bad" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {preview.map((c) => (
            <span
              key={c.id}
              title={c.title}
              className="size-8 rounded-md bg-background overflow-hidden shrink-0 border border-border/60"
            >
              <IntegrationIcon
                icon={c.icon ?? undefined}
                name={c.title}
                size="xs"
                className="rounded-none border-0"
              />
            </span>
          ))}
          {total === 0 && (
            <span className="text-xs text-muted-foreground">
              No connections yet
            </span>
          )}
        </div>
      </div>
    </TileFrame>
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
  const dot =
    tone === "ok"
      ? "bg-emerald-500"
      : tone === "bad"
        ? "bg-rose-500"
        : "bg-muted-foreground/40";
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className="text-2xl font-semibold text-foreground leading-none tabular-nums tracking-tight">
        {value}
      </span>
      <div className="flex items-center gap-1.5">
        <span className={cn("size-1.5 rounded-full shrink-0", dot)} />
        <span className="text-[11px] text-muted-foreground">{label}</span>
      </div>
    </div>
  );
}

/* ---------- studio.shortcuts ---------- */

type ShortcutId = "agents" | "connections" | "monitor" | "general";

const DEFAULT_SHORTCUTS: { id: ShortcutId; label: string; icon: ReactNode }[] =
  [
    { id: "agents", label: "Agents", icon: <Users03 size={16} /> },
    { id: "connections", label: "Connections", icon: <Server01 size={16} /> },
    { id: "monitor", label: "Monitor", icon: <Activity size={16} /> },
    { id: "general", label: "Settings", icon: <Tool01 size={16} /> },
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
    <TileFrame title="Shortcuts" icon={<Star01 size={14} />}>
      <div className="grid grid-cols-2 grid-rows-2 gap-2 flex-1 min-h-0">
        {DEFAULT_SHORTCUTS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => goTo(s.id)}
            className="flex h-full flex-col items-start justify-between gap-3 rounded-lg bg-background hover:bg-background/80 transition-colors text-left p-4 min-h-0 border border-border/60 hover:border-primary/40"
          >
            <span className="flex size-8 items-center justify-center rounded-md bg-muted/50 text-foreground">
              {s.icon}
            </span>
            <span className="text-[13px] font-medium text-foreground">
              {s.label}
            </span>
          </button>
        ))}
      </div>
    </TileFrame>
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
    <TileFrame title="Notes" icon={<BookOpen01 size={14} />}>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Quick scratchpad…"
        className="flex-1 resize-none rounded-lg bg-background border border-border/60 text-[13px] focus-visible:ring-1 focus-visible:ring-primary/30 focus-visible:ring-offset-0"
      />
    </TileFrame>
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

  const cards: { label: string; value: number }[] = [
    { label: "Active agents", value: activeAgents },
    { label: "All agents", value: totalAgents },
    { label: "Connections", value: activeConnections },
    { label: "Errors", value: erroredConnections },
  ];

  return (
    <TileFrame title="Workspace stats" icon={<TrendUp02 size={14} />}>
      <div className="grid grid-cols-2 grid-rows-2 gap-x-6 gap-y-4 flex-1 min-h-0">
        {cards.map((s) => (
          <div key={s.label} className="flex flex-col gap-1.5 min-h-0">
            <span className="text-2xl font-semibold text-foreground leading-none tabular-nums tracking-tight">
              {s.value}
            </span>
            <span className="text-[11px] text-muted-foreground truncate">
              {s.label}
            </span>
          </div>
        ))}
      </div>
    </TileFrame>
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
  const config = (instance.config ?? {}) as AgentCardConfig;
  const title = config.title ?? "Agent";
  const description = config.description;
  const icon = config.icon;
  const refId = config.agentId ?? config.templateId;

  const hasBody = instance.h >= 2 || instance.w >= 2;

  const handleClick = () => {
    const taskId = crypto.randomUUID();
    navigate({
      to: "/$org/$taskId",
      params: { org: org.slug, taskId },
      search: refId ? { virtualmcpid: refId } : undefined,
    });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="group flex h-full w-full flex-col items-start justify-between gap-4 p-5 text-left min-h-0"
      aria-label={`Open ${title}`}
    >
      <div className="flex items-center justify-between gap-3 w-full shrink-0">
        <AgentAvatar icon={icon} name={title} size="sm+" />
        <span className="flex size-7 items-center justify-center rounded-md text-muted-foreground/0 group-hover:bg-background group-hover:text-foreground border border-transparent group-hover:border-border/60 transition-colors">
          <ArrowRight size={14} />
        </span>
      </div>
      <div className="flex flex-col gap-2 min-w-0 w-full flex-1 min-h-0 justify-end">
        <p className="text-[15px] font-medium text-foreground tracking-tight leading-tight truncate">
          {title}
        </p>
        {hasBody && description && (
          <p className="text-[12px] text-muted-foreground line-clamp-3 leading-snug">
            {description}
          </p>
        )}
      </div>
    </button>
  );
}

/* ---------- unknown ---------- */

export function UnknownTile({ instance }: TileRenderProps) {
  return (
    <TileFrame title="Unknown tile" icon={<Zap size={14} />}>
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center">
        <p className="text-sm text-muted-foreground">
          Tile type <code className="text-foreground">{instance.type}</code>{" "}
          isn't installed.
        </p>
      </div>
    </TileFrame>
  );
}

/* ---------- skeletons / loading ---------- */

export function TileSkeleton() {
  return (
    <div className="flex h-full flex-col p-5 gap-4">
      <div className="flex items-center gap-2">
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="h-3 w-20" />
      </div>
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}
