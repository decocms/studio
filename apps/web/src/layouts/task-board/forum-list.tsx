import { useForumSearch } from "./forum-controls";
import { useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare01, AtSign, ArrowNarrowDown } from "@untitledui/icons";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { taskKey } from "@decocms/shared/task-key";
import type {
  StudioToolInput,
  StudioToolOutput,
} from "@decocms/shared/tools/tool-io";
import { useProjectContext } from "@/sdk";
import { useStudioTools } from "@/lib/studio-tools";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t";
import { getInitials } from "@/lib/get-initials";
import { formatTimeAgo } from "@/lib/format-time";
import { useTaskConversationEvents } from "@/hooks/use-task-conversation-events";
import { authClient } from "@/lib/auth-client";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import {
  laneVisual,
  isTaskBlocked,
  isTaskHandedToHuman,
  laneHeader,
  SUPER_AGENT_ASSIGNEE_ID,
  type TaskBoardItem,
  type Member,
} from "./config";

type ForumInput = StudioToolInput<"TASK_BOARD_FORUM_LIST">;
type Summary = StudioToolOutput<"TASK_BOARD_FORUM_LIST">["items"][number];

export function ForumList({
  items,
  members,
  onOpen,
}: {
  items: TaskBoardItem[];
  members: Member[];
  onOpen: (item: TaskBoardItem) => void;
}) {
  const t = useT();
  const { locator, org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const { filter, sort } = useForumSearch();
  const [updates, setUpdates] = useState(false);
  const itemIds = items.map((item) => item.id).sort();
  const input = { itemIds, filter, sort } satisfies ForumInput;
  const query = useInfiniteQuery({
    queryKey: KEYS.taskBoardForumPage(locator, session?.user.id, input),
    initialPageParam: undefined as ForumInput["cursor"],
    queryFn: ({ pageParam }) =>
      studio.call("TASK_BOARD_FORUM_LIST", { ...input, cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });
  useTaskConversationEvents((_itemId, reason) => {
    if (reason === "activity") {
      setUpdates(true);
      return;
    }
    // Acknowledging a conversation is already an explicit user action. Keep
    // every cached tab/filter current, including a list behind the detail.
    setUpdates(false);
    void queryClient.invalidateQueries({
      queryKey: KEYS.taskBoardForum(locator),
      refetchType: "all",
    });
  }, true);
  const byId = new Map(items.map((item) => [item.id, item]));
  const summaries = [
    ...new Map(
      (query.data?.pages.flatMap((page) => page.items) ?? []).map((row) => [
        row.id,
        row,
      ]),
    ).values(),
  ];
  const memberById = new Map(members.map((member) => [member.userId, member]));
  const personName = (id: string) =>
    id === SUPER_AGENT_ASSIGNEE_ID
      ? t("taskBoard.taskDialog.superAgentLabel")
      : id === session?.user.id
        ? t("taskBoard.taskDialog.commentYouLabel")
        : (memberById.get(id)?.user?.name ??
          t("taskBoard.taskDialog.someoneLabel"));
  const personAvatar = (id: string) =>
    id === SUPER_AGENT_ASSIGNEE_ID ? (
      <SuperAgentIcon size={22} />
    ) : (
      <Avatar
        url={memberById.get(id)?.user?.image ?? undefined}
        fallback={getInitials(personName(id))}
        size="xs"
        shape="circle"
      />
    );
  const preview = (summary: Summary) =>
    (summary.lastReply?.body ?? "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[#*_`>]/g, "")
      .replace(/\s+/g, " ");

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto px-4 pb-16 sm:px-8"
      data-testid="task-forum"
    >
      <div className="mx-auto w-full max-w-[1680px]">
        {updates && (
          <div className="flex justify-center py-3">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setUpdates(false);
                void query.refetch();
              }}
            >
              <ArrowNarrowDown size={14} />
              {t("taskBoard.forum.updates")}
            </Button>
          </div>
        )}
        {query.isPending && (
          <div className="flex justify-center p-12">
            <Spinner />
          </div>
        )}
        {query.isError && (
          <div className="flex items-center justify-center gap-3 p-8">
            <p className="text-sm text-destructive">
              {t("taskBoard.forum.loadFailed")}
            </p>
            <Button variant="outline" onClick={() => void query.refetch()}>
              {t("taskBoard.forum.retry")}
            </Button>
          </div>
        )}
        {!query.isPending && !query.isError && summaries.length === 0 && (
          <p className="py-20 text-center text-sm text-muted-foreground">
            {t("taskBoard.forum.empty")}
          </p>
        )}
        {summaries
          .filter((row) => byId.has(row.id))
          .map((row) => {
            const item = byId.get(row.id)!;
            const visual = laneVisual(item.status);
            const key = taskKey(org.slug, item.keySeq);
            return (
              <button
                key={row.id}
                type="button"
                onClick={() => onOpen(item)}
                data-testid="task-forum-row"
                className={cn(
                  "flex w-full items-center gap-3 border-t border-border px-3 py-5 text-left transition-colors hover:bg-muted/40 sm:gap-5 sm:px-4",
                  row.mentionCount > 0 && "bg-accent/30",
                )}
              >
                <span
                  aria-label={
                    row.unreadCount ? t("taskBoard.forum.unread") : undefined
                  }
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    row.unreadCount ? "bg-success" : "bg-transparent",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                    {item.title}
                    {(isTaskBlocked(item) || isTaskHandedToHuman(item)) && (
                      <span className="rounded border border-warning/40 px-1.5 py-0.5 text-[10px] text-warning">
                        {t(
                          isTaskBlocked(item)
                            ? "taskBoard.taskBoard.needsInput"
                            : "taskBoard.taskBoard.needsYou",
                        )}
                      </span>
                    )}
                    {row.mentionCount > 0 && (
                      <span className="inline-flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-[10px] font-normal text-accent-foreground">
                        <AtSign size={11} />
                        {t("taskBoard.forum.mentionedYou")}
                      </span>
                    )}
                  </span>
                  <span className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                    {row.lastReply ? (
                      <>
                        <span className="shrink-0">
                          {personAvatar(row.lastReply.authorId)}
                        </span>
                        <span className="truncate">
                          {personName(row.lastReply.authorId)}: {preview(row)}
                        </span>
                      </>
                    ) : (
                      <span>{t("taskBoard.forum.noReplies")}</span>
                    )}
                  </span>
                  <span className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    {key && <span>{key}</span>}
                    {item.repo && (
                      <>
                        <span>·</span>
                        <span>{item.repo}</span>
                      </>
                    )}
                    <span>·</span>
                    <span className="inline-flex items-center gap-1">
                      <visual.icon size={12} />
                      {laneHeader(item.status, t).label}
                    </span>
                  </span>
                </span>
                <span
                  className="hidden items-center -space-x-1.5 md:flex"
                  aria-label={t("taskBoard.forum.participants")}
                >
                  {row.participantIds.slice(0, 3).map((id) => (
                    <span
                      key={id}
                      className="rounded-full ring-2 ring-background"
                      title={personName(id)}
                    >
                      {personAvatar(id)}
                    </span>
                  ))}
                  {row.participantIds.length > 3 && (
                    <span className="pl-3 text-xs text-muted-foreground">
                      +{row.participantIds.length - 3}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 flex-col items-end gap-2 text-xs text-muted-foreground">
                  <time dateTime={new Date(row.lastActivityAt).toISOString()}>
                    {formatTimeAgo(new Date(row.lastActivityAt))}
                  </time>
                  <span
                    className="inline-flex items-center gap-1.5"
                    aria-label={t("taskBoard.forum.replyCount", {
                      count: row.replyCount,
                    })}
                  >
                    <MessageSquare01 size={13} />
                    {row.replyCount}
                    {row.unreadCount > 0 && (
                      <span
                        className="rounded bg-accent px-1.5 py-0.5 text-[10px] text-accent-foreground"
                        aria-label={t("taskBoard.forum.unreadCount", {
                          count: row.unreadCount,
                        })}
                      >
                        +{row.unreadCount}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            );
          })}
        {query.hasNextPage && (
          <div className="flex justify-center py-8">
            <Button
              variant="outline"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {t("taskBoard.forum.loadMore")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
