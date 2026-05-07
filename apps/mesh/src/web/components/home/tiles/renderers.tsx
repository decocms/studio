/**
 * All v1 tile renderers live here. Real data plumbing is intentionally
 * mocked — the goal is to prove the tile contract. Each renderer assumes
 * its host provides the right amount of room (the catalog declares
 * supportedSizes).
 */

import type { ReactNode } from "react";
import { useId, useState } from "react";
import { authClient } from "@/web/lib/auth-client";
import { useNavigate } from "@tanstack/react-router";
import { useProjectContext, useConnections } from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useLocalStorage } from "@/web/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import { IntegrationIcon } from "@/web/components/integration-icon";
import {
  Activity,
  AlertCircle,
  ArrowRight,
  BookOpen01,
  Calendar,
  Clock,
  Coins04,
  GitBranch01,
  Globe02,
  Lightning01,
  MessageCircle01,
  Server01,
  ShieldTick,
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

/* ---------- studio.recent-agents ---------- */

const MOCK_RECENT_AGENTS = [
  { id: "site-editor", name: "Site Editor", icon: "✏️" },
  { id: "ai-image", name: "AI Image", icon: "🎨" },
  { id: "research", name: "Deep Research", icon: "🔎" },
  { id: "lean-canvas", name: "Lean Canvas", icon: "📋" },
  { id: "studio-pack", name: "Studio Pack", icon: "📦" },
];

export function RecentAgentsTile(_props: TileRenderProps) {
  const navigate = useNavigate();
  const { org } = useProjectContext();
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
      <ul className="flex flex-col gap-0.5 -mx-2">
        {MOCK_RECENT_AGENTS.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              className="flex items-center gap-3 w-full px-2 py-2 rounded-md hover:bg-muted transition-colors text-left"
              onClick={() => {
                const taskId = crypto.randomUUID();
                navigate({
                  to: "/$org/$taskId",
                  params: { org: org.slug, taskId },
                });
              }}
            >
              <span className="text-base">{a.icon}</span>
              <span className="text-sm text-foreground truncate flex-1">
                {a.name}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </TileFrame>
  );
}

/* ---------- studio.recent-tasks ---------- */

const MOCK_RECENT_TASKS = [
  { id: "t1", title: "Refactor billing pipeline", status: "in-progress" },
  { id: "t2", title: "Draft Q2 launch announcement", status: "review" },
  { id: "t3", title: "Triage Linear inbox", status: "in-progress" },
  { id: "t4", title: "Audit GitHub Actions costs", status: "blocked" },
];

const TASK_DOT: Record<string, string> = {
  "in-progress": "bg-primary",
  review: "bg-amber-500",
  blocked: "bg-rose-500",
};

const TASK_LABEL: Record<string, string> = {
  "in-progress": "In progress",
  review: "Review",
  blocked: "Blocked",
};

export function RecentTasksTile(_props: TileRenderProps) {
  return (
    <TileFrame title="Recent tasks" icon={<Clock size={14} />}>
      <ul className="flex flex-col gap-3">
        {MOCK_RECENT_TASKS.map((t) => (
          <li key={t.id} className="flex items-center gap-2.5 min-w-0">
            <span
              className={cn(
                "size-1.5 rounded-full shrink-0",
                TASK_DOT[t.status] ?? "bg-muted-foreground/40",
              )}
            />
            <span className="text-[13px] text-foreground truncate flex-1">
              {t.title}
            </span>
            <span className="text-[11px] text-muted-foreground shrink-0">
              {TASK_LABEL[t.status] ?? t.status}
            </span>
          </li>
        ))}
      </ul>
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

/* ---------- studio.connections-overview ---------- */

export function ConnectionsOverviewTile(_props: TileRenderProps) {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const connections = useConnections();
  const total = connections.length;
  const active = connections.filter((c) => c.status === "active").length;
  const error = connections.filter((c) => c.status === "error").length;
  const inactive = total - active - error;
  const preview = connections.slice(0, 8);

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

/* ---------- studio.stats ---------- */

type StatDelta = "up" | "down" | "flat";

const MOCK_STATS: {
  label: string;
  value: string | number;
  delta: string;
  trend: StatDelta;
}[] = [
  { label: "Tasks today", value: 14, delta: "+3", trend: "up" },
  { label: "Tools called", value: 287, delta: "+42", trend: "up" },
  { label: "Connections", value: 12, delta: "0", trend: "flat" },
  { label: "Tokens (24h)", value: "118k", delta: "−5%", trend: "down" },
];

const TREND_TONE: Record<StatDelta, string> = {
  up: "text-emerald-600 dark:text-emerald-400",
  down: "text-rose-600 dark:text-rose-400",
  flat: "text-muted-foreground",
};

export function StatsTile(_props: TileRenderProps) {
  return (
    <TileFrame title="Workspace stats" icon={<TrendUp02 size={14} />}>
      <div className="grid grid-cols-2 grid-rows-2 gap-x-6 gap-y-4 flex-1 min-h-0">
        {MOCK_STATS.map((s) => (
          <div key={s.label} className="flex flex-col gap-1.5 min-h-0">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold text-foreground leading-none tabular-nums tracking-tight">
                {s.value}
              </span>
              <span
                className={cn(
                  "text-[11px] font-medium tabular-nums",
                  TREND_TONE[s.trend],
                )}
              >
                {s.delta}
              </span>
            </div>
            <span className="text-[11px] text-muted-foreground truncate">
              {s.label}
            </span>
          </div>
        ))}
      </div>
    </TileFrame>
  );
}

/* ---------- mock.github.activity ---------- */

const MOCK_COMMITS = [
  {
    id: "c1",
    message: "feat(auth): add SSO configurations",
    author: "ada",
    when: "2h",
  },
  {
    id: "c2",
    message: "fix(billing): handle Stripe webhook retries",
    author: "linus",
    when: "4h",
  },
  {
    id: "c3",
    message: "refactor(home): extract dashboard tiles",
    author: "you",
    when: "6h",
  },
  {
    id: "c4",
    message: "chore: bump @decocms/mesh-sdk",
    author: "rita",
    when: "1d",
  },
];

export function GithubActivityTile(_props: TileRenderProps) {
  return (
    <TileFrame title="GitHub activity" icon={<GitBranch01 size={14} />}>
      <ScrollArea className="flex-1 -mx-2">
        <ul className="flex flex-col gap-3 px-2">
          {MOCK_COMMITS.map((c) => (
            <li key={c.id} className="flex flex-col gap-0.5 min-w-0">
              <p className="text-[13px] text-foreground truncate">
                {c.message}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {c.author} · {c.when} ago
              </p>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </TileFrame>
  );
}

/* ---------- mock.linear.issues ---------- */

const MOCK_ISSUES = [
  {
    id: "ENG-431",
    title: "Migrate connections page to org-scoped paths",
    priority: "high",
  },
  {
    id: "ENG-432",
    title: "Investigate event-bus retry storm in staging",
    priority: "urgent",
  },
  { id: "ENG-440", title: "Audit log retention", priority: "med" },
  { id: "DSN-22", title: "Tile resize hover states", priority: "low" },
];

const PRIORITY_COLOR: Record<string, string> = {
  urgent: "text-rose-600 dark:text-rose-400",
  high: "text-amber-600 dark:text-amber-400",
  med: "text-primary",
  low: "text-muted-foreground",
};

export function LinearIssuesTile(_props: TileRenderProps) {
  return (
    <TileFrame title="My issues" icon={<AlertCircle size={14} />}>
      <ul className="flex flex-col gap-3">
        {MOCK_ISSUES.map((i) => (
          <li key={i.id} className="flex items-center gap-2.5 min-w-0">
            <span
              className={cn(
                "shrink-0 text-[10px] font-mono tabular-nums tracking-tight",
                PRIORITY_COLOR[i.priority],
              )}
            >
              {i.id}
            </span>
            <span className="text-[13px] text-foreground truncate flex-1">
              {i.title}
            </span>
          </li>
        ))}
      </ul>
    </TileFrame>
  );
}

/* ---------- mock.calendar.upcoming ---------- */

const MOCK_EVENTS = [
  { id: "e1", title: "Standup", at: "09:30 — 10:00" },
  { id: "e2", title: "Tile UX review with Diego", at: "11:00 — 11:30" },
  { id: "e3", title: "Customer call: Acme", at: "14:00 — 14:45" },
];

export function CalendarTile(_props: TileRenderProps) {
  return (
    <TileFrame title="Today" icon={<Calendar size={14} />}>
      <ul className="flex flex-col gap-3.5">
        {MOCK_EVENTS.map((e) => (
          <li key={e.id} className="flex items-center gap-3 min-w-0">
            <span className="text-[11px] text-muted-foreground tabular-nums shrink-0 w-[88px]">
              {e.at.split(" — ")[0]}
            </span>
            <span className="text-[13px] text-foreground truncate flex-1">
              {e.title}
            </span>
          </li>
        ))}
      </ul>
    </TileFrame>
  );
}

/* ---------- agent.card ---------- */

interface AgentTask {
  id: string;
  title: string;
  status?: "in-progress" | "review" | "blocked" | "done";
}

interface AgentCardConfig {
  templateId?: string;
  agentId?: string;
  title?: string;
  description?: string;
  icon?: string;
  fallbackIcon?: string;
  /**
   * Optional running tasks for this agent. Mocked in the catalog/seed
   * today; will be wired to live agent activity later. When present
   * and the tile has vertical room (h >= 2), they replace the
   * description as the card body so the agent feels "alive".
   */
  tasks?: AgentTask[];
}

const AGENT_TASK_DOT: Record<string, string> = {
  "in-progress": "bg-primary",
  review: "bg-amber-500",
  blocked: "bg-rose-500",
  done: "bg-emerald-500",
};

export function AgentCardTile({ instance }: TileRenderProps) {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const config = (instance.config ?? {}) as AgentCardConfig;
  const title = config.title ?? "Agent";
  const description = config.description;
  const icon = config.icon;
  const refId = config.agentId ?? config.templateId;
  const tasks = config.tasks ?? [];

  // Vertical room drives what we render under the header. 1×1 stays
  // icon + title only; 1×2 and larger fit a body (tasks if any, else
  // description).
  const hasBody = instance.h >= 2 || instance.w >= 2;
  const showTasks = hasBody && tasks.length > 0;
  const showDescription = hasBody && !showTasks && Boolean(description);

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
        <IntegrationIcon
          icon={icon}
          name={title}
          size="md"
          fallbackIcon={<Users03 size={20} />}
        />
        <span className="flex size-7 items-center justify-center rounded-md text-muted-foreground/0 group-hover:bg-background group-hover:text-foreground border border-transparent group-hover:border-border/60 transition-colors">
          <ArrowRight size={14} />
        </span>
      </div>
      <div className="flex flex-col gap-2 min-w-0 w-full flex-1 min-h-0 justify-end">
        <p className="text-[15px] font-medium text-foreground tracking-tight leading-tight truncate">
          {title}
        </p>
        {showTasks && (
          <ul className="flex flex-col gap-2 min-w-0">
            {tasks.slice(0, instance.h >= 2 ? 3 : 2).map((t) => (
              <li key={t.id} className="flex items-center gap-2.5 min-w-0">
                <span
                  className={cn(
                    "size-1.5 rounded-full shrink-0",
                    AGENT_TASK_DOT[t.status ?? "in-progress"] ??
                      "bg-muted-foreground/40",
                  )}
                />
                <span className="text-[12px] text-foreground/90 truncate">
                  {t.title}
                </span>
              </li>
            ))}
            {tasks.length > 3 && instance.h >= 2 && (
              <li className="text-[11px] text-muted-foreground">
                +{tasks.length - 3} more
              </li>
            )}
          </ul>
        )}
        {showDescription && (
          <p className="text-[12px] text-muted-foreground line-clamp-3 leading-snug">
            {description}
          </p>
        )}
      </div>
    </button>
  );
}

/* ---------- agent.reliability ---------- */

const RELIABILITY_ERRORS = [3, 2, 8, 5, 3, 12, 4, 2, 1, 5, 3, 7, 2, 1];

export function ReliabilityAgentTile(_props: TileRenderProps) {
  const gradientId = useId();
  const data = RELIABILITY_ERRORS;
  const today = data[data.length - 1] ?? 0;
  const yesterday = data[data.length - 2] ?? 0;
  const total = data.reduce((sum, v) => sum + v, 0);
  const delta =
    yesterday > 0 ? Math.round(((today - yesterday) / yesterday) * 100) : 0;
  const max = Math.max(1, ...data);
  const w = 320;
  const h = 100;
  const stepX = w / (data.length - 1);
  const points = data.map((v, i) => ({
    x: i * stepX,
    y: h - (v / max) * h,
  }));
  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`)
    .join(" ");
  const areaPath = `${linePath} L${w},${h} L0,${h} Z`;
  const lastPoint = points[points.length - 1]!;

  const trendTone =
    delta < 0
      ? "text-emerald-600 dark:text-emerald-400"
      : delta > 0
        ? "text-rose-600 dark:text-rose-400"
        : "text-muted-foreground";
  const trendLabel =
    delta === 0 ? "no change" : `${delta > 0 ? "+" : ""}${delta}%`;

  return (
    <TileFrame title="Reliability Agent" icon={<ShieldTick size={14} />}>
      <div className="flex flex-col gap-4 flex-1 min-h-0">
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold text-foreground tabular-nums tracking-tight leading-none">
              {today}
            </span>
            <span className="text-[11px] text-muted-foreground">
              errors today
            </span>
          </div>
          <span
            className={cn(
              "text-[11px] font-medium tabular-nums shrink-0",
              trendTone,
            )}
          >
            {trendLabel} vs yesterday
          </span>
        </div>
        <div className="flex-1 min-h-0 flex items-end">
          <svg
            viewBox={`0 0 ${w} ${h}`}
            className="w-full h-full text-rose-500"
            preserveAspectRatio="none"
            aria-hidden
          >
            <defs>
              <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
                <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={areaPath} fill={`url(#${gradientId})`} />
            <path
              d={linePath}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={lastPoint.x}
              cy={lastPoint.y}
              r={3}
              fill="currentColor"
            />
          </svg>
        </div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground tabular-nums">
          <span>{data.length}d ago</span>
          <span>{total} total · last 14 days</span>
          <span>now</span>
        </div>
      </div>
    </TileFrame>
  );
}

/* ---------- agent.app-frame ---------- */

/**
 * Stand-in for an MCP-app-contributed tile rendered inside an iframe.
 * The TileFrame header shows the app name; the iframe body renders the
 * app's own UI. Padding around the iframe is intentionally tighter than
 * the header padding so the embedded view feels like an inset surface
 * rather than a paragraph of content.
 *
 * srcdoc + sandbox="" — no scripts, no same-origin, no forms. The mock
 * is plain HTML/CSS, theme-aware via prefers-color-scheme.
 */

const APP_FRAME_DOC = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
:root{color-scheme:light dark;--bg:hsl(0 0% 100%);--fg:hsl(240 10% 4%);--muted:hsl(240 5% 96%);--muted-fg:hsl(240 4% 46%);--accent:hsl(259 67% 56%);--row-line:hsl(240 4% 90%);}
@media(prefers-color-scheme:dark){:root{--bg:hsl(240 10% 6%);--fg:hsl(0 0% 98%);--muted:hsl(240 4% 14%);--muted-fg:hsl(240 5% 65%);--accent:hsl(259 67% 70%);--row-line:hsl(240 4% 18%);}}
*{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;}
body{font-family:-apple-system,BlinkMacSystemFont,Inter,sans-serif;background:var(--bg);color:var(--fg);font-size:13px;line-height:1.4;padding:14px 16px;overflow:hidden;}
.kpi{display:flex;gap:20px;margin-bottom:14px;}
.metric{flex:1;min-width:0;}
.value{font-size:22px;font-weight:600;letter-spacing:-0.02em;line-height:1;margin-bottom:4px;font-variant-numeric:tabular-nums;}
.delta{font-size:11px;color:var(--accent);font-weight:500;margin-left:6px;}
.label{font-size:10px;color:var(--muted-fg);text-transform:uppercase;letter-spacing:0.04em;}
.list{display:flex;flex-direction:column;}
.row{display:flex;align-items:center;justify-content:space-between;padding:8px 2px;border-top:1px solid var(--row-line);}
.row:first-child{border-top:0;}
.row .name{font-weight:500;}
.row .meta{color:var(--muted-fg);font-variant-numeric:tabular-nums;}
.dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--accent);margin-right:8px;vertical-align:middle;}
.title{font-size:11px;color:var(--muted-fg);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px;}
</style></head><body>
<div class="kpi">
  <div class="metric"><div class="value">$12,480<span class="delta">+8.2%</span></div><div class="label">Revenue</div></div>
  <div class="metric"><div class="value">142</div><div class="label">Charges</div></div>
  <div class="metric"><div class="value">98.6%</div><div class="label">Success</div></div>
</div>
<div class="title">Latest charges</div>
<div class="list">
  <div class="row"><span><span class="dot"></span>Acme Corp</span><span class="meta">$1,200 · 14:02</span></div>
  <div class="row"><span><span class="dot"></span>Globex</span><span class="meta">$840 · 13:45</span></div>
  <div class="row"><span><span class="dot"></span>Initech</span><span class="meta">$2,400 · 13:21</span></div>
  <div class="row"><span><span class="dot"></span>Umbrella</span><span class="meta">$390 · 12:58</span></div>
</div>
</body></html>`;

export function AppFrameTile(_props: TileRenderProps) {
  return (
    <TileFrame title="Stripe payments" icon={<Coins04 size={14} />}>
      <div className="flex-1 min-h-0 -mx-3 -mb-3 rounded-xl overflow-hidden bg-background border border-border/60">
        <iframe
          title="Stripe payments app"
          srcDoc={APP_FRAME_DOC}
          sandbox=""
          className="w-full h-full block border-0"
        />
      </div>
    </TileFrame>
  );
}

/* ---------- mock.analytics.chart ---------- */

export function AnalyticsChartTile(_props: TileRenderProps) {
  // Tiny SVG sparkline so we don't pull in recharts for a mock.
  const data = [12, 18, 14, 22, 26, 21, 30, 28, 34, 31, 38, 42];
  const max = Math.max(...data);
  const min = Math.min(...data);
  const w = 260;
  const h = 80;
  const stepX = w / (data.length - 1);
  const points = data
    .map((v, i) => {
      const x = i * stepX;
      const y = h - ((v - min) / Math.max(1, max - min)) * h;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <TileFrame title="Page views" icon={<Globe02 size={14} />}>
      <div className="flex flex-col gap-2 flex-1 justify-end">
        <div className="flex items-baseline justify-between">
          <span className="text-2xl font-semibold text-foreground">42.1k</span>
          <span className="text-xs text-primary">▲ 12.4%</span>
        </div>
        <svg
          viewBox={`0 0 ${w} ${h}`}
          className="w-full h-16"
          preserveAspectRatio="none"
          aria-hidden
        >
          <polyline
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            className="text-primary"
          />
        </svg>
      </div>
    </TileFrame>
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
    <div className="flex h-full flex-col p-4 gap-3">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

export const TILE_FRAME_BG =
  "bg-background border border-border rounded-[0.75rem]";

export const TILE_FRAME_BG_INSET =
  "bg-background border border-border/60 rounded-[0.75rem]";

export const __RENDERER_PRESENT = true;
