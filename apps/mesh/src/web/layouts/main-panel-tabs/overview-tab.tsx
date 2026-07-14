/**
 * Overview tab — the Super Agent's default main view.
 *
 * There is no bespoke "home" screen anymore: the org landing is just the
 * Super Agent, and the Super Agent opens on this view (its
 * `metadata.ui.layout.defaultMainView = { type: "overview" }`). It's a plain
 * main-panel view like Settings or Automations — any agent could point at it.
 *
 * v1 shows recent conversations across the whole org (who on the team ran
 * what, and when). Clicking a row opens that thread.
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
import { MainPanelLoading } from "./main-panel-loading";

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

function RecentConversations() {
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
      const res = await studio.call("COLLECTION_THREADS_LIST", { limit: 24 });
      return (res.items ?? []) as OverviewThread[];
    },
    staleTime: 30_000,
  });

  if (threads.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <MessageChatCircle className="size-8 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          No conversations yet. Start one below and it'll show up here for your
          team.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
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
            className="group flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent/60"
          >
            <Avatar
              shape="circle"
              size="sm"
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

export function OverviewTab() {
  const { org } = useProjectContext();
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-10">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-foreground">{org.name}</h1>
          <p className="text-sm text-muted-foreground">
            Recent conversations across your team. Pick up where someone left
            off, or start something new in the chat.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <h2 className="px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Recent conversations
          </h2>
          <Suspense fallback={<MainPanelLoading />}>
            <RecentConversations />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
