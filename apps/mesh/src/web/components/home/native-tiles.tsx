/**
 * Native home tiles — built-in React tiles that live on the home board next to
 * agent tiles. They aren't agents, so they aren't tracked in
 * `default_home_agents`; instead they're always-present board candidates whose
 * on/off state rides the board layout (see home-grid + the add-tile drawer's
 * "Built-in tiles" section).
 *
 * The default board is the four product tiles below: Tasks (real task-board
 * data) plus Coding / Analytics / Sales (visual mocks whose hover CTA invites
 * the user to connect the backing integration). Recent conversations is still
 * available but `defaultHidden` — re-add it from Customize.
 */
import { Suspense, useId } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  BarChart10,
  CheckCircle,
  GitBranch01,
  MessageChatCircle,
  ShoppingCart01,
  TrendDown01,
  TrendUp01,
} from "@untitledui/icons";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useStudioTools } from "@/web/lib/studio-tools";
import { useMembers } from "@/web/hooks/use-members";
import { useTaskBoardItems } from "@/web/hooks/use-task-board-items";
import { STATUS_CONFIG } from "@/web/layouts/task-board/config";
import { GitHubIcon } from "@/web/components/icons/github-icon";
import { KEYS } from "@/web/lib/query-keys";

const TASKS_TILE_ID = "tasks";
const CODING_TILE_ID = "coding";
const ANALYTICS_TILE_ID = "analytics";
const SALES_TILE_ID = "sales";
const RECENT_CONVERSATIONS_TILE_ID = "recent-conversations";

export interface NativeTileDef {
  id: string;
  title: string;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  /** When true, the tile is NOT on the default board — it only appears once
   *  the user adds it from Customize (which writes it a stored position). */
  defaultHidden?: boolean;
}

/** Native tiles offered on the home board, in display order. The first four
 *  form the default board (2×2 in the 4-col grid). */
export const NATIVE_TILES: NativeTileDef[] = [
  {
    id: TASKS_TILE_ID,
    title: "Tasks",
    defaultSize: { w: 2, h: 4 },
    minSize: { w: 2, h: 2 },
  },
  {
    id: CODING_TILE_ID,
    title: "Coding",
    defaultSize: { w: 2, h: 4 },
    minSize: { w: 2, h: 2 },
  },
  {
    id: ANALYTICS_TILE_ID,
    title: "Analytics",
    defaultSize: { w: 2, h: 4 },
    minSize: { w: 2, h: 2 },
  },
  {
    id: SALES_TILE_ID,
    title: "Sales",
    defaultSize: { w: 2, h: 4 },
    minSize: { w: 2, h: 2 },
  },
  {
    id: RECENT_CONVERSATIONS_TILE_ID,
    title: "Recent conversations",
    // Full width (grid is 4 cols) × 4 rows.
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 2, h: 2 },
    defaultHidden: true,
  },
];

/** The board candidate id for a native tile. */
export function nativeCandidateId(nativeId: string): string {
  return `native:${nativeId}`;
}

// ---------------------------------------------------------------------------
// Recent conversations
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<string, { label: string; className: string }> = {
  completed: { label: "Completed", className: "text-success" },
  in_progress: { label: "Running", className: "text-foreground" },
  requires_action: { label: "Needs input", className: "text-foreground" },
  failed: { label: "Failed", className: "text-destructive" },
  expired: { label: "Expired", className: "text-muted-foreground" },
};

interface OverviewThread {
  id: string;
  title: string;
  created_by: string;
  updated_at: string;
  virtual_mcp_id?: string;
  status?: string;
}

interface OrgMember {
  userId: string;
  user?: { name?: string; email?: string; image?: string | null };
}

function RecentConversationsList() {
  const { org, locator } = useProjectContext();
  const studio = useStudioTools();
  const navigate = useNavigate();
  const { data: membersData } = useMembers();

  const members = (membersData?.data?.members ?? []) as OrgMember[];
  const memberByUserId = new Map(members.map((m) => [m.userId, m] as const));

  const { data: threads } = useSuspenseQuery({
    queryKey: KEYS.overviewThreads(locator),
    queryFn: async (): Promise<OverviewThread[]> => {
      // No `userId` filter → org-wide (the whole team's recent threads).
      const res = await studio.call("COLLECTION_THREADS_LIST", { limit: 12 });
      return (res.items ?? []) as OverviewThread[];
    },
    staleTime: 30_000,
  });

  if (threads.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <MessageChatCircle className="size-6 text-muted-foreground/50" />
        <p className="text-xs text-muted-foreground">
          No conversations yet. Start one and it'll show up here for your team.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5 overflow-y-auto p-1.5">
      {threads.map((thread) => {
        const member = memberByUserId.get(thread.created_by);
        const authorName =
          member?.user?.name ?? member?.user?.email?.split("@")[0] ?? "Someone";
        const status = thread.status ? STATUS_LABEL[thread.status] : undefined;
        const when = thread.updated_at
          ? formatDistanceToNow(new Date(thread.updated_at), {
              addSuffix: true,
            })
          : null;
        return (
          <button
            key={thread.id}
            type="button"
            onClick={() =>
              navigate({
                to: "/$org/$taskId",
                params: { org: org.slug, taskId: thread.id },
                search: thread.virtual_mcp_id
                  ? { virtualmcpid: thread.virtual_mcp_id }
                  : {},
              })
            }
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent/60"
          >
            <Avatar
              shape="circle"
              size="xs"
              url={member?.user?.image ?? undefined}
              fallback={authorName.slice(0, 2).toUpperCase()}
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium text-foreground">
                {thread.title || "Untitled conversation"}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {authorName}
                {when ? ` · ${when}` : ""}
              </span>
            </div>
            {status && (
              <span className={cn("shrink-0 text-xs", status.className)}>
                {status.label}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tasks (real task-board data)
// ---------------------------------------------------------------------------

function TasksTileBody() {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const { items, isLoading, error } = useTaskBoardItems();

  const openBoard = () =>
    navigate({ to: "/$org/board", params: { org: org.slug } });

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 p-3">
        {Array.from({ length: 4 }, (_, i) => (
          <div
            key={`task-skeleton-${i}`}
            className="h-6 w-full animate-pulse rounded-md bg-muted/40"
          />
        ))}
      </div>
    );
  }

  // An error usually means the task board is off for this org; either way,
  // show the empty affordance rather than a scary error.
  if (error || items.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <CheckCircle className="size-6 text-muted-foreground/50" />
        <p className="text-xs text-muted-foreground">No tasks yet.</p>
        <Button size="sm" variant="ghost" onClick={openBoard} className="h-7">
          Open task board
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5 overflow-y-auto p-1.5">
      {items.slice(0, 8).map((item) => {
        const cfg = STATUS_CONFIG[item.status];
        const Icon = cfg.icon;
        return (
          <button
            key={item.id}
            type="button"
            onClick={openBoard}
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-accent/60"
          >
            <Icon className={cn("size-4 shrink-0", cfg.iconClassName)} />
            <span className="truncate text-sm text-foreground">
              {item.title}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mock tiles — Coding / Analytics / Sales. Static sample data; a hover overlay
// invites the user to connect the real integration (not wired yet).
// ---------------------------------------------------------------------------

function MockConnectOverlay({
  label,
  icon,
}: {
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background/70 opacity-0 backdrop-blur-sm transition-opacity duration-150 group-hover/mock:opacity-100">
      <Button size="sm" variant="secondary" className="gap-2 shadow-sm">
        {icon}
        {label}
      </Button>
    </div>
  );
}

function MockTile({
  children,
  connectLabel,
  connectIcon,
}: {
  children: React.ReactNode;
  connectLabel: string;
  connectIcon: React.ReactNode;
}) {
  return (
    <div className="group/mock relative flex h-full flex-col overflow-hidden">
      <div className="flex flex-1 flex-col p-3">{children}</div>
      <MockConnectOverlay label={connectLabel} icon={connectIcon} />
    </div>
  );
}

/** A tiny deterministic contributions grid (7 rows × 14 weeks). Static
 *  classes so Tailwind keeps the opacity variants. */
const CONTRIB_LEVEL_CLASS = [
  "bg-foreground/10",
  "bg-foreground/25",
  "bg-foreground/45",
  "bg-foreground/70",
];
function ContributionsGrid() {
  return (
    <div className="flex gap-1">
      {Array.from({ length: 14 }, (_, col) => (
        <div key={`col-${col}`} className="flex flex-col gap-1">
          {Array.from({ length: 7 }, (_, row) => {
            // Deterministic pseudo-pattern — stable render, no randomness.
            const cls = CONTRIB_LEVEL_CLASS[(col * 7 + row) % 4];
            return (
              <div
                key={`cell-${col}-${row}`}
                className={cn("size-2 rounded-[2px]", cls)}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

const MOCK_PRS = [
  { id: 128, title: "Fix checkout flow", state: "merged" },
  { id: 127, title: "Add product search", state: "open" },
  { id: 126, title: "Bump deps", state: "merged" },
];

function CodingTileBody() {
  return (
    <MockTile
      connectLabel="Connect GitHub"
      connectIcon={<GitHubIcon className="size-4" />}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="text-2xl font-semibold tracking-tight tabular-nums text-foreground">
            128
          </span>
          <span className="text-xs text-muted-foreground">
            Contributions this month
          </span>
        </div>
        <TrendDelta delta={18} />
      </div>
      <ContributionsGrid />
      <div className="mt-3 flex flex-col gap-1.5">
        {MOCK_PRS.map((pr) => (
          <div key={pr.id} className="flex items-center gap-2 text-xs">
            <GitBranch01 className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-foreground">{pr.title}</span>
            <span
              className={cn(
                "ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                pr.state === "merged"
                  ? "bg-success/10 text-success"
                  : "bg-muted text-muted-foreground",
              )}
            >
              #{pr.id}
            </span>
          </div>
        ))}
      </div>
    </MockTile>
  );
}

/** A soft area sparkline: neutral line with a faint gradient fill. Scales to
 *  its container; a unique gradient id keeps multiple charts independent. */
function AreaSparkline({
  data,
  className,
}: {
  data: number[];
  className?: string;
}) {
  const gradientId = useId();
  const W = 100;
  const H = 40;
  const PAD = 3;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * W;
    const y = H - PAD - ((v - min) / range) * (H - PAD * 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = pts.join(" ");
  const area = `0,${H} ${line} ${W},${H}`;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={cn("w-full text-foreground/70", className)}
      aria-hidden
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity={0.16} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gradientId})`} stroke="none" />
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Trend pill: green up / red down, next to a metric's headline number. */
function TrendDelta({ delta }: { delta: number }) {
  const up = delta >= 0;
  const Icon = up ? TrendUp01 : TrendDown01;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums",
        up ? "text-success" : "text-destructive",
      )}
    >
      <Icon className="size-3" />
      {up ? "+" : ""}
      {delta}%
    </span>
  );
}

/** One KPI: label + trend, a big number, and its own sparkline. Shared by the
 *  Analytics and Sales tiles so every metric reads the same way. */
function MetricStat({
  label,
  value,
  delta,
  data,
}: {
  label: string;
  value: string;
  delta: number;
  data: number[];
}) {
  return (
    <div className="flex flex-1 flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <TrendDelta delta={delta} />
      </div>
      <span className="text-2xl font-semibold tracking-tight tabular-nums text-foreground">
        {value}
      </span>
      <AreaSparkline data={data} className="mt-1 h-12" />
    </div>
  );
}

const PAGEVIEWS_SERIES = [
  8.9, 9.4, 9.1, 10.2, 10.8, 11.1, 11.6, 11.9, 12.1, 12.4,
];
const SESSIONS_SERIES = [3.4, 3.3, 3.5, 3.2, 3.4, 3.1, 3.3, 3.0, 3.1, 3.2];
const REVENUE_SERIES = [
  5200, 5600, 5400, 6100, 5900, 6800, 7200, 7000, 7900, 8240,
];
const ORDERS_SERIES = [98, 105, 101, 118, 112, 126, 131, 128, 138, 142];

function AnalyticsTileBody() {
  return (
    <MockTile
      connectLabel="Connect Google Analytics"
      connectIcon={<BarChart10 className="size-4" />}
    >
      <div className="flex flex-1 flex-col gap-4">
        <MetricStat
          label="Pageviews"
          value="12.4k"
          delta={5}
          data={PAGEVIEWS_SERIES}
        />
        <div className="h-px bg-border/60" />
        <MetricStat
          label="Sessions"
          value="3.2k"
          delta={-2}
          data={SESSIONS_SERIES}
        />
      </div>
    </MockTile>
  );
}

function SalesTileBody() {
  return (
    <MockTile
      connectLabel="Connect VTEX or Shopify"
      connectIcon={<ShoppingCart01 className="size-4" />}
    >
      <div className="flex flex-1 flex-col gap-4">
        <MetricStat
          label="Revenue"
          value="$8,240"
          delta={12}
          data={REVENUE_SERIES}
        />
        <div className="h-px bg-border/60" />
        <MetricStat label="Orders" value="142" delta={8} data={ORDERS_SERIES} />
      </div>
    </MockTile>
  );
}

// ---------------------------------------------------------------------------
// Registry renderer
// ---------------------------------------------------------------------------

/**
 * Renders a native tile's body by id. Unknown ids render nothing (the tile
 * still occupies its cell, but degrades gracefully). Chrome (drag handle,
 * remove menu) is supplied by the board in edit mode, same as any tile.
 */
export function NativeTile({ nativeId }: { nativeId: string }) {
  const def = NATIVE_TILES.find((t) => t.id === nativeId);
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-background">
      <div className="shrink-0 border-b border-border/60 px-3 py-2 text-xs font-medium text-muted-foreground">
        {def?.title ?? "Tile"}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {nativeId === RECENT_CONVERSATIONS_TILE_ID ? (
          <Suspense
            fallback={<div className="h-full animate-pulse bg-muted/30" />}
          >
            <RecentConversationsList />
          </Suspense>
        ) : nativeId === TASKS_TILE_ID ? (
          <TasksTileBody />
        ) : nativeId === CODING_TILE_ID ? (
          <CodingTileBody />
        ) : nativeId === ANALYTICS_TILE_ID ? (
          <AnalyticsTileBody />
        ) : nativeId === SALES_TILE_ID ? (
          <SalesTileBody />
        ) : null}
      </div>
    </div>
  );
}
