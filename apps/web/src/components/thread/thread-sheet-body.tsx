/**
 * Read-only transcript of one agent thread, for a Sheet.
 *
 * Three surfaces show a thread without navigating into its chat: Monitoring →
 * Threads, an automation's Runs tab, and a task's linked runs. They own the
 * `<Sheet>`; this renders its whole body, header included.
 *
 * It reuses the live chat's own `MessagePair`, which reads the ambient chat
 * contexts for things like a message's produced files. Those contexts belong
 * to whatever chat is on screen behind the sheet — a different thread — so the
 * body renders inside `DetachedChatContext`, which blanks them. See
 * {@link ThreadSheetBody}.
 */

import { Suspense } from "react";
import type { useConnections, useVirtualMCPs } from "@/sdk";
import { useMCPClient } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { SheetHeader, SheetTitle } from "@decocms/ui/components/sheet.tsx";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { ChevronUp, ChevronDown, Container } from "@untitledui/icons";
import { ErrorBoundary } from "@/components/error-boundary";
import {
  MessagePair,
  useMessagePairs,
} from "@/components/chat/message/pair.tsx";
import { DetachedChatContext } from "@/components/chat/context.tsx";
import type { ChatMessage } from "@/components/chat/types.ts";
import type {
  StudioThread as Thread,
  StudioThreadMessage as ThreadMessage,
} from "@decocms/shared/entities";
import { IntegrationIcon } from "@/components/integration-icon.tsx";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll.ts";
import type { useMembers } from "@/hooks/use-members";
import { KEYS } from "@/lib/query-keys";
import { STATUS_CONFIG } from "@/lib/task-status";
import {
  getOrgMembers,
  getThreadAgentId,
  resolveAgentIcon,
  resolveAgentName,
} from "@/routes/orgs/monitoring/utils.ts";

// ── Thread types (pick only the fields we need from the server types) ───────

export type ThreadEntity = Pick<
  Thread,
  | "id"
  | "title"
  | "status"
  | "created_by"
  | "created_at"
  | "updated_at"
  | "virtual_mcp_id"
  | "run_config"
>;

/**
 * What the sheet actually reads. Looser than {@link ThreadEntity}, which it is
 * satisfied by: a task board's linked run has a nullable title and status and
 * carries no `created_by` or `run_config` at all.
 */
export interface ThreadSheetThread {
  id: string;
  title: string | null;
  status: string | null;
  created_at: string;
  created_by?: string | null;
  virtual_mcp_id?: string | null;
  run_config?: Record<string, unknown> | null;
}

/** Walking a list of threads from inside the sheet. Omit it and the header
 *  shows no prev/next — a task's runs are read one at a time. */
export interface ThreadSheetNav {
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}

type ThreadMessageEntity = Pick<
  ThreadMessage,
  | "id"
  | "thread_id"
  | "role"
  | "parts"
  | "metadata"
  | "created_at"
  | "updated_at"
>;

// ── Sheet header (extracted to avoid repetition) ────────────────────────────

function ThreadSheetHeader({
  thread,
  connections,
  virtualMcps,
  nav,
}: {
  thread: ThreadSheetThread;
  connections: ReturnType<typeof useConnections>;
  virtualMcps: ReturnType<typeof useVirtualMCPs>;
  nav?: ThreadSheetNav;
}) {
  const t = useT();
  const agentId = getThreadAgentId(thread);
  const agentName = resolveAgentName(agentId, virtualMcps, connections, "");
  const agentIcon = resolveAgentIcon(agentId, virtualMcps, connections);

  return (
    <SheetHeader className="px-5 md:px-6 pt-6 pb-5 border-b border-border shrink-0">
      <div className="flex items-start justify-between gap-3 pr-8">
        <div className="flex items-center gap-3 min-w-0">
          <IntegrationIcon
            icon={agentIcon}
            name={agentName || thread.title || t("orgs.threads.untitledChat")}
            size="sm"
            fallbackIcon={<Container />}
            className="shadow-sm shrink-0 rounded-md"
          />
          <div className="min-w-0">
            <SheetTitle className="text-sm leading-snug truncate">
              {thread.title || t("orgs.threads.untitledChat")}
            </SheetTitle>
            {agentName && (
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                {agentName}
              </p>
            )}
          </div>
        </div>
        {nav && (
          <div className="flex items-center gap-0.5 shrink-0">
            <Button
              size="icon"
              variant="ghost"
              onClick={nav.onPrev}
              disabled={nav.index === 0}
              className="h-7 w-7 text-muted-foreground"
              aria-label={t("orgs.threads.previousChat")}
            >
              <ChevronUp size={14} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={nav.onNext}
              disabled={nav.index === nav.total - 1}
              className="h-7 w-7 text-muted-foreground"
              aria-label={t("orgs.threads.nextChat")}
            >
              <ChevronDown size={14} />
            </Button>
          </div>
        )}
      </div>
    </SheetHeader>
  );
}

// ── Thread meta row ─────────────────────────────────────────────────────────

function ThreadMetaRow({
  thread,
  connections,
  virtualMcps,
  members,
}: {
  thread: ThreadSheetThread;
  connections: ReturnType<typeof useConnections>;
  virtualMcps: ReturnType<typeof useVirtualMCPs>;
  members: ReturnType<typeof useMembers>["data"] | undefined;
}) {
  const t = useT();
  const agentId = getThreadAgentId(thread);
  const agentName = resolveAgentName(agentId, virtualMcps, connections, "");
  const agentIcon = resolveAgentIcon(agentId, virtualMcps, connections);

  const membersList = getOrgMembers(members);
  const member = membersList.find((m) => m.userId === thread.created_by);
  const userName =
    member?.user.name ??
    member?.user.email ??
    thread.created_by?.substring(0, 8) ??
    "\u2014";
  const userImage = member?.user.image ?? undefined;

  const date = new Date(thread.created_at);
  const formattedDate = date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const statusCfg =
    STATUS_CONFIG[thread.status as keyof typeof STATUS_CONFIG] ??
    STATUS_CONFIG.completed;
  const StatusIcon = statusCfg.icon;

  return (
    <div className="px-5 md:px-6 py-5 border-b border-border grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4 text-sm">
      <div>
        <div className="text-xs text-muted-foreground mb-1">
          {t("orgs.threads.status")}
        </div>
        <div className="flex items-center gap-1.5">
          <StatusIcon size={13} className={statusCfg.iconClassName} />
          <span className={cn("text-sm", statusCfg.labelColor)}>
            {statusCfg.label}
          </span>
        </div>
      </div>

      <div>
        <div className="text-xs text-muted-foreground mb-1">
          {t("orgs.threads.date")}
        </div>
        <div className="text-sm text-foreground">{formattedDate}</div>
      </div>

      {thread.created_by && (
        <div>
          <div className="text-xs text-muted-foreground mb-1">
            {t("orgs.threads.user")}
          </div>
          <div className="flex items-center gap-2">
            <Avatar
              url={userImage}
              fallback={userName}
              shape="circle"
              size="2xs"
              className="shrink-0"
            />
            <span className="text-sm text-foreground">{userName}</span>
          </div>
        </div>
      )}

      {agentName && (
        <div>
          <div className="text-xs text-muted-foreground mb-1">
            {t("orgs.threads.agent")}
          </div>
          <div className="flex items-center gap-2">
            <IntegrationIcon
              icon={agentIcon}
              name={agentName}
              size="xs"
              fallbackIcon={<Container />}
              className="shrink-0 size-5! min-w-5! rounded-md"
            />
            <span className="text-sm text-foreground">{agentName}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Conversation panel ──────────────────────────────────────────────────────

const MESSAGES_PAGE_SIZE = 100;

function ThreadConversationPanelEmpty() {
  const t = useT();
  return (
    <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
      {t("orgs.threads.noMessagesInChat")}
    </div>
  );
}

function ThreadConversationPanelLoading() {
  const t = useT();
  return (
    <div className="py-4 text-center text-xs text-muted-foreground">
      {t("orgs.threads.loadingMore")}
    </div>
  );
}

function ThreadConversationPanel({
  client,
  locator,
  thread,
  connections,
  virtualMcps,
  members,
  nav,
  meta,
}: {
  client: ReturnType<typeof useMCPClient>;
  locator: string;
  thread: ThreadSheetThread;
  connections: ReturnType<typeof useConnections>;
  virtualMcps: ReturnType<typeof useVirtualMCPs>;
  members: ReturnType<typeof useMembers>["data"] | undefined;
  nav?: ThreadSheetNav;
  meta: boolean;
}) {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery({
      queryKey: KEYS.threadMessages(locator, thread.id),
      queryFn: async ({ pageParam = 0 }) => {
        if (!client) throw new Error("MCP client is not available");
        const result = (await client.callTool({
          name: "COLLECTION_THREAD_MESSAGES_LIST",
          arguments: {
            thread_id: thread.id,
            limit: MESSAGES_PAGE_SIZE,
            offset: pageParam,
          },
        })) as { structuredContent?: unknown };
        return (result.structuredContent ?? result) as {
          items: ThreadMessageEntity[];
          totalCount: number;
          hasMore: boolean;
        };
      },
      initialPageParam: 0 as number,
      getNextPageParam: (lastPage, allPages) => {
        const page = lastPage as { items?: ThreadMessageEntity[] } | undefined;
        const pages = allPages as Array<{ items?: ThreadMessageEntity[] }>;
        if ((page?.items?.length ?? 0) < MESSAGES_PAGE_SIZE) return undefined;
        return pages.length * MESSAGES_PAGE_SIZE;
      },
      staleTime: 60_000,
    });

  const allItems = data.pages.flatMap(
    (p: { items?: ThreadMessageEntity[] }) => p.items ?? [],
  );
  const rawMessages = allItems as unknown as ChatMessage[];
  const messages = rawMessages.filter(
    (m) => m.role === "user" || m.role === "assistant",
  );
  const messagePairs = useMessagePairs(messages);

  const lastMsgRef = useInfiniteScroll(
    () => {
      if (hasNextPage && !isFetchingNextPage) fetchNextPage();
    },
    hasNextPage ?? false,
    isFetchingNextPage,
  );

  return (
    <>
      <ThreadSheetHeader
        thread={thread}
        connections={connections}
        virtualMcps={virtualMcps}
        nav={nav}
      />
      {meta && (
        <ThreadMetaRow
          thread={thread}
          connections={connections}
          virtualMcps={virtualMcps}
          members={members}
        />
      )}

      {messages.length === 0 ? (
        <ThreadConversationPanelEmpty />
      ) : (
        <div data-chat-scroller className="flex-1 overflow-y-auto min-h-0">
          <div className="flex flex-col min-w-0 max-w-2xl mx-auto w-full">
            {messagePairs.map((pair, idx) => (
              <div
                key={`pair-${pair.user?.id ?? pair.assistant?.id}`}
                ref={
                  idx === messagePairs.length - 1
                    ? (lastMsgRef as (node: HTMLDivElement | null) => void)
                    : undefined
                }
              >
                <MessagePair
                  pair={pair}
                  isLastPair={idx === messagePairs.length - 1}
                  status="ready"
                />
              </div>
            ))}
            {isFetchingNextPage && <ThreadConversationPanelLoading />}
          </div>
        </div>
      )}
    </>
  );
}

// ── Thread sheet wrapper (renders header once, body swaps for loading/error) ─

function ThreadSheetBodyError() {
  const t = useT();
  return (
    <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
      {t("orgs.threads.failedToLoadMessages")}
    </div>
  );
}

function ThreadSheetBodyLoading() {
  const t = useT();
  return (
    <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
      {t("orgs.threads.loadingConversation")}
    </div>
  );
}

export function ThreadSheetBody({
  thread,
  client,
  locator,
  connections,
  virtualMcps,
  members,
  nav,
  meta = true,
}: {
  thread: ThreadSheetThread;
  client: ReturnType<typeof useMCPClient>;
  locator: string;
  connections: ReturnType<typeof useConnections>;
  virtualMcps: ReturnType<typeof useVirtualMCPs>;
  members: ReturnType<typeof useMembers>["data"] | undefined;
  nav?: ThreadSheetNav;
  /** The status / date / user / agent grid under the header. On a task the
   *  card it opened from already says all of it. */
  meta?: boolean;
}) {
  return (
    <DetachedChatContext>
      <ErrorBoundary
        fallback={
          <>
            <ThreadSheetHeader
              thread={thread}
              connections={connections}
              virtualMcps={virtualMcps}
              nav={nav}
            />
            <ThreadSheetBodyError />
          </>
        }
      >
        <Suspense
          fallback={
            <>
              <ThreadSheetHeader
                thread={thread}
                connections={connections}
                virtualMcps={virtualMcps}
                nav={nav}
              />
              <ThreadSheetBodyLoading />
            </>
          }
        >
          <ThreadConversationPanel
            client={client}
            locator={locator}
            thread={thread}
            connections={connections}
            virtualMcps={virtualMcps}
            members={members}
            nav={nav}
            meta={meta}
          />
        </Suspense>
      </ErrorBoundary>
    </DetachedChatContext>
  );
}
