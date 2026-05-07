/**
 * All v1 tile renderers live here. Real data plumbing is intentionally
 * mocked — the goal is to prove the tile contract. Each renderer assumes
 * its host provides the right amount of room (the catalog declares
 * supportedSizes).
 */

import type { ReactNode } from "react";
import { useState } from "react";
import { authClient } from "@/web/lib/auth-client";
import { useNavigate } from "@tanstack/react-router";
import { useProjectContext, useConnections } from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
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
  GitBranch01,
  Globe02,
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
  badge,
  action,
  children,
  hint,
}: {
  title: string;
  icon: ReactNode;
  badge?: ReactNode;
  action?: { label: string; onClick: () => void };
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex h-full flex-col p-4 gap-3 min-h-0">
      <div className="flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex size-6 items-center justify-center rounded-md bg-muted text-muted-foreground shrink-0">
            {icon}
          </span>
          <span className="text-sm font-medium text-foreground truncate">
            {title}
          </span>
          {badge}
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
      {hint && (
        <p className="text-[10px] text-muted-foreground/70 shrink-0">{hint}</p>
      )}
    </div>
  );
}

function MockBadge() {
  return (
    <Badge variant="outline" className="text-[10px] h-4 px-1.5 font-normal">
      Mock
    </Badge>
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
    <div className="flex h-full items-center justify-between gap-6 p-5 bg-gradient-to-br from-primary/5 via-background to-background rounded-[0.75rem]">
      <div className="flex flex-col gap-1 min-w-0">
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
      <ul className="flex flex-col gap-1 -mx-2">
        {MOCK_RECENT_AGENTS.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md hover:bg-muted transition-colors text-left"
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

const TASK_STATUS_COLOR: Record<string, string> = {
  "in-progress": "bg-primary/15 text-primary",
  review: "bg-warning/15 text-warning",
  blocked: "bg-destructive/15 text-destructive",
};

export function RecentTasksTile(_props: TileRenderProps) {
  return (
    <TileFrame
      title="Recent tasks"
      icon={<Clock size={14} />}
      badge={<MockBadge />}
    >
      <ul className="flex flex-col gap-2">
        {MOCK_RECENT_TASKS.map((t) => (
          <li
            key={t.id}
            className="flex items-center justify-between gap-2 py-1"
          >
            <span className="text-sm text-foreground truncate flex-1">
              {t.title}
            </span>
            <span
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-md capitalize",
                TASK_STATUS_COLOR[t.status] ?? "bg-muted text-muted-foreground",
              )}
            >
              {t.status.replace("-", " ")}
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
      <div className="flex flex-col gap-2 flex-1 min-h-0">
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
      <div className="flex flex-col gap-3 flex-1 min-h-0 justify-between">
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat label="Active" value={active} tone="ok" />
          <Stat label="Inactive" value={inactive} tone="muted" />
          <Stat label="Errors" value={error} tone="bad" />
        </div>
        <div className="flex flex-wrap gap-2">
          {preview.map((c) => (
            <span
              key={c.id}
              title={c.title}
              className="size-9 rounded-md border border-border overflow-hidden shrink-0"
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
  const colour =
    tone === "ok"
      ? "text-primary"
      : tone === "bad"
        ? "text-destructive"
        : "text-foreground";
  return (
    <div className="flex flex-col items-center justify-center rounded-md bg-muted/40 py-2">
      <span className={cn("text-lg font-semibold", colour)}>{value}</span>
      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
        {label}
      </span>
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
            className="flex h-full flex-col items-start justify-between gap-2 rounded-lg border border-border bg-muted/30 hover:bg-muted hover:border-primary/30 transition-colors text-left p-3 min-h-0"
          >
            <span className="flex size-8 items-center justify-center rounded-md bg-background text-foreground border border-border">
              {s.icon}
            </span>
            <span className="text-sm font-medium text-foreground">
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
        className="flex-1 resize-none border-0 bg-transparent px-0 focus-visible:ring-0 focus-visible:ring-offset-0"
      />
    </TileFrame>
  );
}

/* ---------- studio.stats ---------- */

const MOCK_STATS = [
  { label: "Tasks today", value: 14, delta: "+3" },
  { label: "Tools called", value: 287, delta: "+42" },
  { label: "Connections", value: 12, delta: "0" },
  { label: "Tokens (24h)", value: "118k", delta: "−5%" },
];

export function StatsTile(_props: TileRenderProps) {
  return (
    <TileFrame
      title="Workspace stats"
      icon={<TrendUp02 size={14} />}
      badge={<MockBadge />}
    >
      <div className="grid grid-cols-2 grid-rows-2 gap-2 flex-1 min-h-0">
        {MOCK_STATS.map((s) => (
          <div
            key={s.label}
            className="flex flex-col justify-between rounded-md bg-muted/30 px-3 py-2 min-h-0"
          >
            <span className="text-2xl font-semibold text-foreground leading-none">
              {s.value}
            </span>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide truncate">
                {s.label}
              </span>
              <span className="text-[10px] text-muted-foreground shrink-0">
                {s.delta}
              </span>
            </div>
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
    <TileFrame
      title="GitHub activity"
      icon={<GitBranch01 size={14} />}
      badge={<MockBadge />}
    >
      <ScrollArea className="flex-1 -mx-2">
        <ul className="flex flex-col px-2">
          {MOCK_COMMITS.map((c) => (
            <li
              key={c.id}
              className="py-2 border-b border-border last:border-0"
            >
              <p className="text-sm text-foreground truncate">{c.message}</p>
              <p className="text-xs text-muted-foreground">
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
  urgent: "bg-destructive/15 text-destructive",
  high: "bg-warning/15 text-warning",
  med: "bg-primary/10 text-primary",
  low: "bg-muted text-muted-foreground",
};

export function LinearIssuesTile(_props: TileRenderProps) {
  return (
    <TileFrame
      title="My issues"
      icon={<AlertCircle size={14} />}
      badge={<MockBadge />}
    >
      <ul className="flex flex-col gap-1.5">
        {MOCK_ISSUES.map((i) => (
          <li key={i.id} className="flex items-center gap-2 py-1 min-w-0">
            <span
              className={cn(
                "shrink-0 text-[10px] px-1.5 py-0.5 rounded-md font-mono",
                PRIORITY_COLOR[i.priority],
              )}
            >
              {i.id}
            </span>
            <span className="text-sm text-foreground truncate flex-1">
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
    <TileFrame
      title="Today"
      icon={<Calendar size={14} />}
      badge={<MockBadge />}
    >
      <ul className="flex flex-col gap-2">
        {MOCK_EVENTS.map((e) => (
          <li key={e.id} className="flex items-start gap-2">
            <span className="mt-1 size-1.5 rounded-full bg-primary shrink-0" />
            <div className="min-w-0">
              <p className="text-sm text-foreground truncate">{e.title}</p>
              <p className="text-xs text-muted-foreground">{e.at}</p>
            </div>
          </li>
        ))}
      </ul>
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
    <TileFrame
      title="Page views"
      icon={<Globe02 size={14} />}
      badge={<MockBadge />}
    >
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
