/**
 * Demo home dashboard — the scripted org overview used for product critique
 * demos. Mirrors the Figma "Product 2" home: an agent summary line, five
 * metric cards (pageviews / sessions / orders / coding / revenue) with striped
 * area charts, and a Tasks section with status tabs and review rows.
 *
 * Everything here is static mock data; nothing runs on mount. Rendered by the
 * Overview tab in place of the customizable tile board.
 */
import { useId, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@deco/ui/components/button.tsx";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@deco/ui/components/chart.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { ArrowDownRight, ArrowUpRight, Clock, Flag01 } from "@untitledui/icons";
import { Area, AreaChart, XAxis } from "recharts";
import {
  PRIORITY_CONFIG,
  STATUS_CONFIG,
  type TaskBoardItemPriority,
} from "@/web/layouts/task-board/config";

/** Same asset as the Super Agent icon in getWellKnownDecopilotVirtualMCP. */
const DECOPILOT_ICON_URL =
  "https://assets.decocache.com/decocms/fd07a578-6b1c-40f1-bc05-88a3b981695d/f7fc4ffa81aec04e37ae670c3cd4936643a7b269.png";

/** Small avatar for the Deco agent. */
function DecoAvatar({ className }: { className?: string }) {
  return (
    <img
      src={DECOPILOT_ICON_URL}
      alt="Deco"
      className={cn("size-4 shrink-0 rounded-full object-cover", className)}
    />
  );
}

// ---------------------------------------------------------------------------
// Metric chart — a real recharts area chart (hover for the point's value). The
// area is filled with a vertical-line pattern to keep the Figma's lined look.
// Green when the metric is up, red when it's down.
// ---------------------------------------------------------------------------

type Tone = "up" | "down";

interface MetricPoint {
  label: string;
  value: number;
}

function MetricChart({
  points,
  tone,
  metricLabel,
}: {
  points: MetricPoint[];
  tone: Tone;
  metricLabel: string;
}) {
  const patternId = useId().replace(/:/g, "");
  const color = tone === "up" ? "var(--success)" : "var(--destructive)";

  return (
    <ChartContainer
      config={{ value: { label: metricLabel, color } }}
      className="h-full w-full"
    >
      <AreaChart
        data={points}
        margin={{ top: 6, right: 0, bottom: 0, left: 0 }}
      >
        <defs>
          <pattern
            id={patternId}
            width={6}
            height={8}
            patternUnits="userSpaceOnUse"
          >
            <line
              x1={0}
              y1={0}
              x2={0}
              y2={8}
              stroke={color}
              strokeOpacity={0.22}
              strokeWidth={4}
            />
          </pattern>
        </defs>
        <XAxis dataKey="label" hide />
        <ChartTooltip
          cursor={{ stroke: "var(--border)" }}
          content={<ChartTooltipContent indicator="line" />}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={2}
          fill={`url(#${patternId})`}
          fillOpacity={1}
          animationDuration={350}
          dot={false}
          activeDot={{
            r: 4,
            fill: color,
            stroke: "var(--background)",
            strokeWidth: 2,
          }}
        />
      </AreaChart>
    </ChartContainer>
  );
}

// ---------------------------------------------------------------------------
// Contributions grid — a GitHub-style commit heatmap (7 rows of weeks). Each
// square carries a deterministic commit count and a hover tooltip. Used for the
// Coding metric instead of the area chart.
// ---------------------------------------------------------------------------

const CONTRIB_WEEKS = 26;
const CONTRIB_DAYS = 7;

/** Deterministic pseudo-random commit count for a (week, day) cell, weighted so
 *  roughly a third of cells are empty and the rest spread across intensities. */
function commitsAt(week: number, day: number): number {
  const h = (week * 31 + day * 17 + 7) % 100;
  if (h < 38) return 0;
  if (h < 60) return 1 + (h % 2);
  if (h < 80) return 3 + (h % 3);
  if (h < 93) return 6 + (h % 3);
  return 9 + (h % 4);
}

function contribLevelClass(count: number): string {
  if (count === 0) return "bg-muted-foreground/15";
  if (count <= 2) return "bg-success/25";
  if (count <= 5) return "bg-success/45";
  if (count <= 8) return "bg-success/70";
  return "bg-success";
}

function ContributionsGrid() {
  return (
    <div className="flex h-full items-center">
      <div className="flex gap-1">
        {Array.from({ length: CONTRIB_WEEKS }, (_, week) => (
          <div key={week} className="flex flex-col gap-1">
            {Array.from({ length: CONTRIB_DAYS }, (_, day) => {
              const count = commitsAt(week, day);
              return (
                <Tooltip key={day}>
                  <TooltipTrigger asChild>
                    <div
                      className={cn(
                        "size-2.5 rounded-[2px]",
                        contribLevelClass(count),
                      )}
                    />
                  </TooltipTrigger>
                  <TooltipContent>
                    {count === 0 ? "No commits" : `${count} commits`}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

interface Metric {
  label: string;
  value: string;
  delta: string;
  tone: Tone;
  data: number[];
  wide?: boolean;
  kind?: "area" | "contributions";
  /** Needs a commerce platform connection: the card renders blurred behind a
   *  persistent connect overlay until one is set up. */
  locked?: boolean;
}

const METRICS: Metric[] = [
  {
    label: "Pageviews",
    value: "12.2k",
    delta: "+1.9%",
    tone: "up",
    data: [9800, 10100, 9950, 10600, 10400, 11000, 11200, 11500, 11900, 12200],
  },
  {
    label: "Sessions",
    value: "3.2k",
    delta: "+25.6%",
    tone: "up",
    data: [2100, 2250, 2200, 2500, 2600, 2750, 2900, 3000, 3100, 3200],
  },
  {
    label: "Orders",
    value: "142",
    delta: "+8.4%",
    tone: "up",
    data: [96, 102, 99, 110, 108, 118, 124, 131, 137, 142],
    locked: true,
  },
  {
    label: "Commits",
    value: "312",
    delta: "+24.0%",
    tone: "up",
    data: [],
    wide: true,
    kind: "contributions",
  },
  {
    label: "Revenue",
    value: "$8,240",
    delta: "+12.0%",
    tone: "up",
    data: [6100, 6400, 6250, 6800, 6700, 7100, 7400, 7700, 8000, 8240],
    wide: true,
    locked: true,
  },
];

/** Label the trailing points as days back from today, so the hover reads like
 *  a real time series ("6d ago", "yesterday", "today"). */
function toPoints(data: number[]): MetricPoint[] {
  return data.map((value, i) => {
    const daysAgo = data.length - 1 - i;
    const label =
      daysAgo === 0 ? "Today" : daysAgo === 1 ? "Yesterday" : `${daysAgo}d ago`;
    return { label, value };
  });
}

function MetricCard({
  metric,
  onConnect,
}: {
  metric: Metric;
  onConnect?: () => void;
}) {
  const up = metric.tone === "up";
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  return (
    <div
      className={cn(
        "flex flex-col rounded-2xl bg-card p-4 card-shadow",
        metric.wide ? "@lg:col-span-2 @3xl:col-span-3" : "@3xl:col-span-2",
      )}
    >
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {metric.label}
      </span>

      <div className="relative mt-2 flex-1">
        <div
          className={cn(
            "flex h-full flex-col",
            // Locked metrics stay blurred and inert behind the connect overlay.
            metric.locked && "pointer-events-none select-none blur-[3px]",
          )}
          aria-hidden={metric.locked}
        >
          <div className="h-28">
            {metric.kind === "contributions" ? (
              <ContributionsGrid />
            ) : (
              <MetricChart
                points={toPoints(metric.data)}
                tone={metric.tone}
                metricLabel={metric.label}
              />
            )}
          </div>
          <div className="mt-3 flex items-center gap-2.5">
            <span className="text-2xl font-medium tabular-nums text-foreground">
              {metric.value}
            </span>
            <span
              className={cn(
                "inline-flex items-center gap-1 text-sm font-medium tabular-nums",
                up ? "text-success" : "text-destructive",
              )}
            >
              <Arrow className="size-4" />
              {metric.delta}
            </span>
          </div>
        </div>

        {metric.locked && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Button size="sm" onClick={onConnect} className="gap-2 shadow-sm">
              <span className="flex items-center -space-x-1.5">
                <img
                  src="/connections/shopify.png"
                  alt="Shopify"
                  className="size-4 rounded-full bg-white object-contain ring-1 ring-background"
                />
                <img
                  src="https://avatars.githubusercontent.com/u/7271388"
                  alt="VTEX"
                  className="size-4 rounded-full bg-white object-contain ring-1 ring-background"
                />
              </span>
              Connect commerce platform
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

type TaskStatus = "in_progress" | "in_review" | "done";

interface DemoHomeTask {
  id: string;
  title: string;
  status: TaskStatus;
  time: string;
  priority: TaskBoardItemPriority;
  effort: string;
}

/** The home surfaces a slice of the demo backlog. Titles, priorities and
 *  estimates mirror the standalone demo board so the two read the same. */
const HOME_TASKS: DemoHomeTask[] = [
  {
    id: "acm-104",
    title: "Fix 12 indexed URLs returning 404",
    status: "in_review",
    time: "4m ago",
    priority: "urgent",
    effort: "1h",
  },
  {
    id: "acm-103",
    title: "Compress hero images on home (4.2 MB total)",
    status: "in_review",
    time: "12m ago",
    priority: "high",
    effort: "2h",
  },
  {
    id: "acm-101",
    title: "Add meta descriptions to 34 product pages",
    status: "in_review",
    time: "1h ago",
    priority: "high",
    effort: "2h",
  },
  {
    id: "acm-105",
    title: "Reduce LCP on /products (4.1s on mobile)",
    status: "in_progress",
    time: "4m ago",
    priority: "high",
    effort: "3h",
  },
  {
    id: "acm-109",
    title: "Add structured data (Product) to PDPs",
    status: "in_progress",
    time: "2h ago",
    priority: "high",
    effort: "2h",
  },
];

const TABS: { id: "all" | TaskStatus; label: string }[] = [
  { id: "all", label: "All" },
  { id: "in_progress", label: "In Progress" },
  { id: "in_review", label: "In Review" },
  { id: "done", label: "Done" },
];

function TaskRow({ task, onOpen }: { task: DemoHomeTask; onOpen: () => void }) {
  const statusConfig = STATUS_CONFIG[task.status];
  const StatusIcon = statusConfig.icon;
  const priority = PRIORITY_CONFIG[task.priority];
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-2xl bg-card px-4 py-3.5 text-left card-shadow transition-shadow hover:shadow-md"
    >
      <StatusIcon
        className={cn("size-4 shrink-0", statusConfig.iconClassName)}
      />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {task.title}
      </span>
      <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
        {/* Same tags the board card shows (assignee, priority, estimate),
            dropped progressively as the panel narrows so the title keeps room. */}
        <span className="hidden items-center gap-1.5 @2xl:inline-flex">
          <DecoAvatar className="size-4" />
          Deco
        </span>
        <span className="inline-flex items-center gap-1">
          <Flag01 className={cn("size-3.5", priority.flagClassName)} />
          <span className="hidden @lg:inline">{priority.label}</span>
        </span>
        <span className="hidden items-center gap-1 @xl:inline-flex">
          <Clock className="size-3.5" />
          {task.effort}
        </span>
        <span className="w-14 text-right">{task.time}</span>
      </div>
    </button>
  );
}

/** Rows shown before the trailing "See all tasks" link. */
const MAX_VISIBLE_TASKS = 4;

function TasksSection({ onOpenBoard }: { onOpenBoard: () => void }) {
  const [tab, setTab] = useState<"all" | TaskStatus>("all");
  const tasks =
    tab === "all" ? HOME_TASKS : HOME_TASKS.filter((t) => t.status === tab);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h2 className="text-base font-medium text-foreground">Tasks</h2>
        <div className="flex items-center gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                tab === t.id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tasks.length === 0 ? (
        <div className="rounded-2xl bg-card px-4 py-10 text-center text-sm text-muted-foreground card-shadow">
          Nothing here right now.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {tasks.slice(0, MAX_VISIBLE_TASKS).map((task) => (
            <TaskRow key={task.id} task={task} onOpen={onOpenBoard} />
          ))}
          <button
            type="button"
            onClick={onOpenBoard}
            className="flex w-full items-center justify-center gap-1.5 rounded-2xl bg-card px-4 py-3 text-sm font-medium text-muted-foreground card-shadow transition-[color,box-shadow] hover:text-foreground hover:shadow-md"
          >
            See all tasks
            <ArrowUpRight className="size-3.5" />
          </button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

export function DemoHome({
  onConnectIntegrations,
}: {
  onConnectIntegrations?: () => void;
}) {
  const navigate = useNavigate();
  // Open the task board in the main panel next to chat (same as the Tasks
  // toolbar toggle) rather than the standalone route.
  const openBoard = () =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, main: "board" }),
    });

  return (
    <div className="h-full overflow-y-auto">
      <div className="@container mx-auto flex w-full max-w-5xl flex-col gap-10 px-10 py-12">
        <div className="flex items-start gap-4 animate-in fade-in slide-in-from-top-1 duration-300">
          <DecoAvatar className="mt-0.5 size-6" />
          <p className="max-w-3xl text-lg font-medium leading-snug text-foreground">
            You have 9 tasks in need of review. I also flagged a 31% traffic
            drop on the bedding collection and a GA4 revenue mismatch that need
            a decision from you.
          </p>
        </div>

        <TasksSection onOpenBoard={openBoard} />

        <div className="grid grid-cols-1 gap-3 @lg:grid-cols-2 @3xl:grid-cols-6">
          {METRICS.map((metric) => (
            <MetricCard
              key={metric.label}
              metric={metric}
              onConnect={onConnectIntegrations}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
