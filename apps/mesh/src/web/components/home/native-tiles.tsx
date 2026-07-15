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
import { Suspense, useState } from "react";
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
  Loading01,
  MessageChatCircle,
  ShoppingCart01,
} from "@untitledui/icons";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useStudioTools } from "@/web/lib/studio-tools";
import { useMembers } from "@/web/hooks/use-members";
import { useTaskBoardItems } from "@/web/hooks/use-task-board-items";
import { STATUS_CONFIG } from "@/web/layouts/task-board/config";
import { GitHubIcon } from "@/web/components/icons/github-icon";
import { AddConnectionDialog } from "@/web/views/virtual-mcp/add-connection-dialog";
import { useConnectApp } from "@/web/hooks/use-connect-app";
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
// connects the backing integration. GitHub / Google Analytics connect directly
// (single known app); Sales opens the catalog (VTEX or Shopify — user picks).
// ---------------------------------------------------------------------------

function MockConnectOverlay({
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
    <div className="absolute inset-0 flex items-center justify-center bg-background/70 opacity-0 backdrop-blur-sm transition-opacity duration-150 group-hover/mock:opacity-100">
      <Button
        size="sm"
        variant="secondary"
        className="gap-2 shadow-sm"
        onClick={onConnect}
        disabled={pending}
      >
        {pending ? <Loading01 className="size-4 animate-spin" /> : icon}
        {label}
      </Button>
    </div>
  );
}

/** Presentational mock-tile shell: sample content + hover connect overlay. */
function MockTile({
  children,
  connectLabel,
  connectIcon,
  onConnect,
  pending,
}: {
  children: React.ReactNode;
  connectLabel: string;
  connectIcon: React.ReactNode;
  onConnect: () => void;
  pending?: boolean;
}) {
  return (
    <div className="group/mock relative flex h-full flex-col overflow-hidden">
      <div className="flex flex-1 flex-col p-3">{children}</div>
      <MockConnectOverlay
        label={connectLabel}
        icon={connectIcon}
        onConnect={onConnect}
        pending={pending}
      />
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
  const { connect, isConnecting } = useConnectApp("deco/mcp-github");
  return (
    <MockTile
      connectLabel="Connect GitHub"
      connectIcon={<GitHubIcon className="size-4" />}
      onConnect={connect}
      pending={isConnecting}
    >
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

const MOCK_SPARKLINE = [8, 12, 10, 16, 14, 20, 18, 26, 24, 30];
function Sparkline() {
  const max = Math.max(...MOCK_SPARKLINE);
  const pts = MOCK_SPARKLINE.map((v, i) => {
    const x = (i / (MOCK_SPARKLINE.length - 1)) * 100;
    const y = 32 - (v / max) * 30;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      className="h-10 w-full text-foreground/70"
      aria-hidden
    >
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function StatNumber({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-lg font-semibold text-foreground">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function AnalyticsTileBody() {
  const { connect, isConnecting } = useConnectApp("deco/google-analytics");
  return (
    <MockTile
      connectLabel="Connect Google Analytics"
      connectIcon={<BarChart10 className="size-4" />}
      onConnect={connect}
      pending={isConnecting}
    >
      <div className="flex gap-6">
        <StatNumber value="12.4k" label="Pageviews" />
        <StatNumber value="3.2k" label="Sessions" />
      </div>
      <div className="mt-auto pt-3">
        <Sparkline />
      </div>
    </MockTile>
  );
}

const MOCK_BARS = [40, 65, 50, 80, 70, 95, 60];
function BarChartMock() {
  const max = Math.max(...MOCK_BARS);
  return (
    <div className="flex h-12 items-end gap-1.5">
      {MOCK_BARS.map((v, i) => (
        <div
          key={`bar-${i}`}
          className="flex-1 rounded-t-sm bg-foreground/60"
          style={{ height: `${(v / max) * 100}%` }}
        />
      ))}
    </div>
  );
}

function SalesTileBody() {
  // VTEX or Shopify — the user picks, so open the catalog rather than
  // connecting a single app directly.
  const [open, setOpen] = useState(false);
  return (
    <>
      <MockTile
        connectLabel="Connect VTEX or Shopify"
        connectIcon={<ShoppingCart01 className="size-4" />}
        onConnect={() => setOpen(true)}
      >
        <div className="flex gap-6">
          <StatNumber value="$8,240" label="Revenue" />
          <StatNumber value="142" label="Orders" />
        </div>
        <div className="mt-auto pt-3">
          <BarChartMock />
        </div>
      </MockTile>
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
