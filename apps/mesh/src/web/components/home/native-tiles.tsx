/**
 * Native home tiles — built-in React tiles that live on the home board next to
 * agent tiles. They aren't agents, so they aren't tracked in
 * `default_home_agents`; instead they're always-present board candidates whose
 * on/off state rides the board layout's `hidden` set (see home-grid + the
 * add-tile drawer's "Built-in tiles" section). Today the only one is recent
 * conversations, but the registry is open for more.
 */
import { Suspense } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { MessageChatCircle } from "@untitledui/icons";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useStudioTools } from "@/web/lib/studio-tools";
import { useMembers } from "@/web/hooks/use-members";
import { KEYS } from "@/web/lib/query-keys";

const RECENT_CONVERSATIONS_TILE_ID = "recent-conversations";

export interface NativeTileDef {
  id: string;
  title: string;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
}

/** Native tiles offered on the home board, in display order. */
export const NATIVE_TILES: NativeTileDef[] = [
  {
    id: RECENT_CONVERSATIONS_TILE_ID,
    title: "Recent conversations",
    // Full width (grid is 4 cols) × 2 rows, sitting under the agent tiles.
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 2, h: 2 },
  },
];

/** The board candidate id for a native tile. */
export function nativeCandidateId(nativeId: string): string {
  return `native:${nativeId}`;
}

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
      {nativeId === RECENT_CONVERSATIONS_TILE_ID ? (
        <Suspense
          fallback={<div className="flex-1 animate-pulse bg-muted/30" />}
        >
          <RecentConversationsList />
        </Suspense>
      ) : null}
    </div>
  );
}
