/**
 * Native home tiles — built-in React tiles that live on the home board next to
 * agent tiles. They aren't agents, so they aren't tracked in
 * `default_home_agents`; instead they're always-present board candidates whose
 * on/off state rides the board layout (see home-grid + the add-tile drawer's
 * "Built-in tiles" section).
 *
 * The default board is the home-redesign metric cards, each as its own tile:
 * Pageviews / Sessions / Orders / Revenue (striped area charts) and Coding (a
 * GitHub contributions calendar). Each tile shows the card design with a sample
 * preview and a hover "Connect" that runs the real connect flow for its backing
 * integration (Google Analytics / VTEX·Shopify / GitHub); once connected it
 * shows real data (GitHub PRs) or an honest placeholder. Tasks is NOT a tile —
 * it's the fixed section above the board (see home-tasks + overview-tab).
 * Recent conversations is available but `defaultHidden` — re-add from Customize.
 *
 * The board wraps every tile in `bg-card card-shadow rounded-2xl`, so each tile
 * body is just the card interior (label + content), matching the redesign.
 */
import { Suspense, useId, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { formatTimeAgo } from "@/web/lib/format-time";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { useT, type TFunction } from "@/web/i18n/use-t.ts";
import type { TranslationKey } from "@/web/i18n/en/index.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@deco/ui/components/chart.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  ArrowUpRight,
  BarChart10,
  CheckCircle,
  GitBranch01,
  Loading01,
  MessageChatCircle,
  ShoppingCart01,
} from "@untitledui/icons";
import { Area, AreaChart, XAxis } from "recharts";
import { useConnections, useProjectContext } from "@decocms/mesh-sdk";
import { getOrgGithubConnections } from "@/shared/github-repo-scope";
import { useConnectApp } from "@/web/hooks/use-connect-app";
import { useGithubRecentPrs } from "@/web/hooks/use-github-recent-prs";
import {
  useGithubContributions,
  CONTRIB_WEEKS,
  type ContribGrid,
} from "@/web/hooks/use-github-contributions";
import { useStudioTools } from "@/web/lib/studio-tools";
import { useMembers } from "@/web/hooks/use-members";
import { GitHubIcon } from "@/web/components/icons/github-icon";
import { AddConnectionDialog } from "@/web/views/virtual-mcp/add-connection-dialog";
import { KEYS } from "@/web/lib/query-keys";

const PAGEVIEWS_TILE_ID = "pageviews";
const SESSIONS_TILE_ID = "sessions";
const ORDERS_TILE_ID = "orders";
const CODING_TILE_ID = "coding";
const REVENUE_TILE_ID = "revenue";
const RECENT_CONVERSATIONS_TILE_ID = "recent-conversations";

export interface NativeTileDef {
  id: string;
  titleKey: TranslationKey;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  /** When true, the tile is NOT on the default board — it only appears once
   *  the user adds it from Customize (which writes it a stored position). */
  defaultHidden?: boolean;
}

/** Native tiles offered on the home board, in display order. All but Recent
 *  conversations form the default board on the 6-column grid: three cards
 *  across (Pageviews + Sessions + Orders, w:2 each), then Revenue + Coding
 *  below at half width (w:3 each). */
export const NATIVE_TILES: NativeTileDef[] = [
  {
    id: PAGEVIEWS_TILE_ID,
    titleKey: "home.nativeTiles.pageviews",
    defaultSize: { w: 2, h: 3 },
    minSize: { w: 1, h: 2 },
  },
  {
    id: SESSIONS_TILE_ID,
    titleKey: "home.nativeTiles.sessions",
    defaultSize: { w: 2, h: 3 },
    minSize: { w: 1, h: 2 },
  },
  {
    id: ORDERS_TILE_ID,
    titleKey: "home.nativeTiles.orders",
    defaultSize: { w: 2, h: 3 },
    minSize: { w: 1, h: 2 },
  },
  {
    id: REVENUE_TILE_ID,
    titleKey: "home.nativeTiles.revenue",
    defaultSize: { w: 3, h: 3 },
    minSize: { w: 2, h: 2 },
  },
  {
    id: CODING_TILE_ID,
    titleKey: "home.nativeTiles.coding",
    defaultSize: { w: 3, h: 3 },
    minSize: { w: 2, h: 2 },
  },
  {
    id: RECENT_CONVERSATIONS_TILE_ID,
    titleKey: "home.nativeTiles.recentConversations",
    // Full width (grid is 6 cols) × 4 rows.
    defaultSize: { w: 6, h: 4 },
    minSize: { w: 2, h: 2 },
    defaultHidden: true,
  },
];

/** The board candidate id for a native tile. */
export function nativeCandidateId(nativeId: string): string {
  return `native:${nativeId}`;
}

// ---------------------------------------------------------------------------
// Metric chart — recharts area chart with a vertical-line fill pattern.
// ---------------------------------------------------------------------------

interface MetricPoint {
  label: string;
  value: number;
}

function MetricChart({
  points,
  metricLabel,
}: {
  points: MetricPoint[];
  metricLabel: string;
}) {
  const patternId = useId().replace(/:/g, "");
  const color = "var(--success)";
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

interface MetricConfig {
  value: string;
  delta: string;
  series: number[];
}

const METRIC_CONFIG: Record<string, MetricConfig> = {
  pageviews: {
    value: "12.2k",
    delta: "+1.9%",
    series: [
      9800, 10100, 9950, 10600, 10400, 11000, 11200, 11500, 11900, 12200,
    ],
  },
  sessions: {
    value: "3.2k",
    delta: "+25.6%",
    series: [2100, 2250, 2200, 2500, 2600, 2750, 2900, 3000, 3100, 3200],
  },
  orders: {
    value: "142",
    delta: "+8.4%",
    series: [96, 102, 99, 110, 108, 118, 124, 131, 137, 142],
  },
  revenue: {
    value: "$8,240",
    delta: "+12.0%",
    series: [6100, 6400, 6250, 6800, 6700, 7100, 7400, 7700, 8000, 8240],
  },
};

function toPoints(data: number[], t: TFunction): MetricPoint[] {
  return data.map((value, i) => {
    const daysAgo = data.length - 1 - i;
    const label =
      daysAgo === 0
        ? t("home.nativeTiles.today")
        : daysAgo === 1
          ? t("home.nativeTiles.yesterday")
          : t("home.nativeTiles.daysAgo", { days: daysAgo });
    return { label, value };
  });
}

function MetricValue({ value, delta }: { value: string; delta: string }) {
  return (
    <div className="mt-3 flex items-center gap-2.5">
      <span className="text-2xl font-medium tabular-nums text-foreground">
        {value}
      </span>
      <span className="inline-flex items-center gap-1 text-sm font-medium tabular-nums text-success">
        <ArrowUpRight className="size-4" />
        {delta}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contributions grid — a GitHub-style commit heatmap (the "collab calendar").
// ---------------------------------------------------------------------------

/** Fake deterministic data shown before GitHub is connected. */
function mockCommitsAt(week: number, day: number): number {
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

function ContributionsGrid({ grid }: { grid?: ContribGrid }) {
  const t = useT();
  return (
    <TooltipProvider delayDuration={0}>
      <div
        className="grid w-full gap-1"
        style={{ gridTemplateColumns: `repeat(${CONTRIB_WEEKS}, 1fr)` }}
      >
        {Array.from({ length: CONTRIB_WEEKS }, (_, week) => (
          <div key={week} className="flex flex-col gap-1">
            {Array.from({ length: 5 }, (_, day) => {
              const count = grid
                ? (grid[week]?.[day] ?? 0)
                : mockCommitsAt(week, day);
              return (
                <Tooltip key={day}>
                  <TooltipTrigger asChild>
                    <div
                      className={cn(
                        "aspect-square rounded-[2px]",
                        contribLevelClass(count),
                      )}
                    />
                  </TooltipTrigger>
                  <TooltipContent>
                    {count === 0
                      ? t("home.nativeTiles.noCommits")
                      : t("home.nativeTiles.commits", { count })}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        ))}
      </div>
    </TooltipProvider>
  );
}

/** Soft always-visible overlay with a connect button over the preview chart. */
function ConnectOverlay({
  label,
  icon,
  onConnect,
  pending,
}: {
  label: string;
  icon: React.ReactNode;
  onConnect: () => void;
  pending?: boolean;
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background/30 backdrop-blur-[2px]">
      <Button
        size="sm"
        onClick={onConnect}
        disabled={pending}
        className="gap-2 shadow-sm"
      >
        {pending ? <Loading01 className="size-4 animate-spin" /> : icon}
        {label}
      </Button>
    </div>
  );
}

/** Connected but the source's reporting isn't wired yet. Honest placeholder,
 *  never a fabricated number. */
function ConnectedSoon({ label }: { label: string }) {
  const t = useT();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <CheckCircle className="size-6 text-success/60" />
      <p className="text-xs text-muted-foreground">
        {t("home.nativeTiles.connectedSoon", { label })}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Analytics metric tiles (Google Analytics) — Pageviews / Sessions
// ---------------------------------------------------------------------------

function AnalyticsMetricTile({
  metricKey,
}: {
  metricKey: keyof typeof METRIC_CONFIG;
}) {
  const t = useT();
  const connected = useConnections({ slug: "google-analytics" }).length > 0;
  const { connect, isConnecting } = useConnectApp("deco/google-analytics");
  const cfg = METRIC_CONFIG[metricKey];
  if (connected || !cfg) return <ConnectedSoon label="Analytics" />;
  return (
    <div className="relative flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <MetricChart points={toPoints(cfg.series, t)} metricLabel={metricKey} />
      </div>
      <MetricValue value={cfg.value} delta={cfg.delta} />
      <ConnectOverlay
        label={t("home.nativeTiles.connectGoogleAnalytics")}
        icon={<BarChart10 className="size-4" />}
        onConnect={connect}
        pending={isConnecting}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Commerce metric tiles (VTEX or Shopify) — Orders / Revenue
// ---------------------------------------------------------------------------

function CommerceMetricTile({
  metricKey,
}: {
  metricKey: keyof typeof METRIC_CONFIG;
}) {
  const t = useT();
  const vtexConnections = useConnections({ slug: "vtex" });
  const shopifyConnections = useConnections({ slug: "shopify" });
  const connected = vtexConnections.length > 0 || shopifyConnections.length > 0;
  const [open, setOpen] = useState(false);
  const cfg = METRIC_CONFIG[metricKey];
  if (connected || !cfg) return <ConnectedSoon label="Commerce" />;
  return (
    <>
      <div className="relative flex h-full flex-col">
        <div className="min-h-0 flex-1">
          <MetricChart
            points={toPoints(cfg.series, t)}
            metricLabel={metricKey}
          />
        </div>
        <MetricValue value={cfg.value} delta={cfg.delta} />
        <ConnectOverlay
          label={t("home.nativeTiles.connectCommercePlatform")}
          icon={<ShoppingCart01 className="size-4" />}
          onConnect={() => setOpen(true)}
        />
      </div>
      <AddConnectionDialog
        mode="browse"
        open={open}
        onOpenChange={setOpen}
        defaultTab="all"
        initialSearch="shopify vtex"
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Coding tile (GitHub) — contributions calendar + headline; real PRs once
// connected.
// ---------------------------------------------------------------------------

function CodingTileBody() {
  const connection = getOrgGithubConnections(
    useConnections({ slug: "mcp-github" }),
  )[0];
  return connection ? (
    <CodingConnected connectionId={connection.id} />
  ) : (
    <CodingDisconnected />
  );
}

function CodingDisconnected() {
  const t = useT();
  const { connect, isConnecting } = useConnectApp("deco/mcp-github");
  return (
    <div className="relative flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-hidden">
        <ContributionsGrid />
      </div>
      <ConnectOverlay
        label={t("home.nativeTiles.connectGithub")}
        icon={<GitHubIcon className="size-4" />}
        onConnect={connect}
        pending={isConnecting}
      />
    </div>
  );
}

function CodingConnected({ connectionId }: { connectionId: string }) {
  const t = useT();
  const { data, isLoading } = useGithubRecentPrs(connectionId);
  const { data: grid } = useGithubContributions(connectionId);
  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden">
      <ContributionsGrid grid={grid} />
      {isLoading ? (
        <div className="flex flex-col gap-1.5">
          {Array.from({ length: 3 }, (_, i) => (
            <div
              key={`pr-skeleton-${i}`}
              className="h-5 w-full animate-pulse rounded-md bg-muted/40"
            />
          ))}
        </div>
      ) : !data || data.repos.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("home.nativeTiles.noRecentPullRequests")}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {data.repos.map((group) => (
            <div key={group.repo} className="flex flex-col gap-0.5">
              <div className="truncate text-xs text-muted-foreground">
                {group.repo}
              </div>
              {group.prs.map((pr) => (
                <a
                  key={`${group.repo}#${pr.number}`}
                  href={pr.htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded-md px-1.5 py-1.5 text-sm transition-colors hover:bg-accent/60"
                >
                  <GitBranch01 className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-foreground">{pr.title}</span>
                  <span
                    className={cn(
                      "ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-xs font-medium",
                      pr.merged
                        ? "bg-success/10 text-success"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    #{pr.number}
                  </span>
                </a>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recent conversations
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<
  string,
  { labelKey: TranslationKey; className: string }
> = {
  completed: {
    labelKey: "home.nativeTiles.statusCompleted",
    className: "text-success",
  },
  in_progress: {
    labelKey: "home.nativeTiles.statusRunning",
    className: "text-foreground",
  },
  requires_action: {
    labelKey: "home.nativeTiles.statusNeedsInput",
    className: "text-foreground",
  },
  failed: {
    labelKey: "home.nativeTiles.statusFailed",
    className: "text-destructive",
  },
  expired: {
    labelKey: "home.nativeTiles.statusExpired",
    className: "text-muted-foreground",
  },
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
  const t = useT();
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
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
        <MessageChatCircle className="size-6 text-muted-foreground/50" />
        <p className="text-xs text-muted-foreground">
          {t("home.nativeTiles.noConversationsYet")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-0.5 overflow-y-auto">
      {threads.map((thread) => {
        const member = memberByUserId.get(thread.created_by);
        const authorName =
          member?.user?.name ?? member?.user?.email?.split("@")[0] ?? "Someone";
        const status = thread.status ? STATUS_LABEL[thread.status] : undefined;
        const when = thread.updated_at
          ? formatTimeAgo(new Date(thread.updated_at))
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
                {thread.title || t("home.nativeTiles.untitledConversation")}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {authorName}
                {when ? ` · ${when}` : ""}
              </span>
            </div>
            {status && (
              <span className={cn("shrink-0 text-xs", status.className)}>
                {t(status.labelKey)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Registry renderer
// ---------------------------------------------------------------------------

function NativeTileBody({ nativeId }: { nativeId: string }) {
  switch (nativeId) {
    case PAGEVIEWS_TILE_ID:
      return <AnalyticsMetricTile metricKey="pageviews" />;
    case SESSIONS_TILE_ID:
      return <AnalyticsMetricTile metricKey="sessions" />;
    case ORDERS_TILE_ID:
      return <CommerceMetricTile metricKey="orders" />;
    case REVENUE_TILE_ID:
      return <CommerceMetricTile metricKey="revenue" />;
    case CODING_TILE_ID:
      return <CodingTileBody />;
    case RECENT_CONVERSATIONS_TILE_ID:
      return (
        <Suspense
          fallback={<div className="h-full animate-pulse bg-muted/30" />}
        >
          <RecentConversationsList />
        </Suspense>
      );
    default:
      return null;
  }
}

/**
 * Renders a native tile by id. The board supplies the card frame
 * (`bg-card card-shadow rounded-2xl`) and edit-mode chrome, so this is just the
 * card interior — a label + body, matching the home-redesign card design.
 * Unknown ids render nothing (the tile still occupies its cell).
 */
export function NativeTile({ nativeId }: { nativeId: string }) {
  const t = useT();
  const def = NATIVE_TILES.find((t) => t.id === nativeId);
  return (
    <div className="flex h-full flex-col overflow-hidden p-4">
      <span className="shrink-0 text-xs font-medium text-muted-foreground">
        {def?.titleKey ? t(def.titleKey) : t("home.nativeTiles.tile")}
      </span>
      <div className="relative mt-2 min-h-0 flex-1">
        <NativeTileBody nativeId={nativeId} />
      </div>
    </div>
  );
}
