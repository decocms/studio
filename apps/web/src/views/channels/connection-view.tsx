/**
 * One connection, laid out as the channels hub lays out its Inbox (skill
 * `channels-design` §3): its conversations in a list beside the one that is
 * open, drawn in the channel's own skin (§6). With nothing open, the reading
 * pane is the connection itself: whether it is receiving, how much it brought
 * in, where its worker posts.
 *
 * Narrow first: the panes answer to their own width (container queries),
 * since the Context menu and the chat change it. Narrow, an open conversation
 * takes the list's place with a back; with nothing open, the connection's
 * summary sits above the list.
 */
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ChevronLeft,
  MessageChatSquare,
  MessageTextSquare01,
  Users01,
} from "@untitledui/icons";
import { useState } from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@decocms/ui/components/alert.tsx";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { MetricCard } from "@decocms/ui/components/metric-card.tsx";
import { SearchInput } from "@decocms/ui/components/search-input.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import type {
  StudioToolIO,
  StudioToolName,
} from "@decocms/shared/tools/tool-io";
import { ChatView, skinOf } from "@/components/channel-skins/index.tsx";
import { ChatText } from "@/components/channel-skins/text.tsx";
import { CopySnippet } from "@/components/connect/copy-snippet.tsx";
import { Page } from "@/components/page";
import { useDebouncedValue } from "@/hooks/use-debounced-value.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useT } from "@/i18n/use-t.ts";
import { channelName } from "@/lib/channel-accounts";
import { formatRelativeTime } from "@/lib/format-time";
import { KEYS } from "@/lib/query-keys";
import {
  callStudioTool,
  StudioToolError,
  useStudioTools,
} from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";
import { ChannelMark } from "./channel-mark.tsx";
import {
  type Connection,
  connectionLabel,
  ingestUrl,
} from "./connection-dialogs.tsx";
import { toChat } from "./to-chat.ts";

type Conversation =
  StudioToolIO["CHANNELS_CONVERSATION_LIST"]["output"]["conversations"][number];

/** CHANNELS_CONNECTION_GET's answer (apps/api src/tools/channels). */
interface ConnectionDetail {
  connection: Connection;
  counts: { conversations: number; messages: number; people: number };
  last_event_at: string | null;
  sync: { source_cursor_at: string | null; last_error: string | null };
}

/**
 * CHANNELS_CONNECTION_GET, typed by hand until the generated tool-io carries
 * it. A server without the tool answers 404 "Unknown tool": the detail then
 * shows what the list already knows.
 */
const getConnection = (orgSlug: string, id: string) =>
  callStudioTool(
    orgSlug,
    "CHANNELS_CONNECTION_GET" as StudioToolName,
    { id } as never,
  ) as unknown as Promise<ConnectionDetail>;

const isUnknownTool = (error: unknown) =>
  error instanceof StudioToolError &&
  error.status === 404 &&
  error.message.startsWith("Unknown tool");

/** Servers, workspaces and spaces are square at their source; people and groups round. */
const squareFaces = (source: string) =>
  source === "discord" || source === "slack";

const LOADING_ROWS = ["a", "b", "c", "d", "e", "f"];

export function ConnectionView({
  connection,
  conversationId,
  onOpen,
}: {
  connection: Connection;
  conversationId: string | undefined;
  onOpen: (conversation: Conversation | null) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const [{ language }] = usePreferences();
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim(), 300);

  const conversations = useInfiniteQuery({
    queryKey: KEYS.channelsConversations(org.id, connection.id, query),
    queryFn: ({ pageParam }) =>
      studio.call("CHANNELS_CONVERSATION_LIST", {
        connection_id: connection.id,
        query: query || undefined,
        cursor: pageParam,
        limit: 50,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = conversations.data?.pages.flatMap((p) => p.conversations) ?? [];
  const current = rows.find((c) => c.id === conversationId);
  const open = !!conversationId;

  return (
    <>
      {/* The open conversation's crumb, named once the list has its row. */}
      <Page.Breadcrumbs
        after="channels-connection"
        items={
          conversationId
            ? [
                {
                  key: "channels-conversation",
                  label: current?.title ?? conversationId,
                },
              ]
            : []
        }
      />
      <div
        className={cn(
          "@container flex min-h-0 flex-1 flex-col border-t @2xl:flex-row @2xl:overflow-hidden",
          !open && "@max-2xl:overflow-y-auto",
        )}
      >
        {/* The list: beside what is open; narrow, gone while something is. */}
        <section
          aria-label={t("channels.conversations")}
          className={cn(
            "min-h-0 flex-col @2xl:flex @2xl:w-80 @2xl:shrink-0 @2xl:border-r",
            // Narrow, the summary and the list stack and the section scrolls.
            open ? "hidden" : "flex shrink-0",
          )}
        >
          <div className="shrink-0 p-2.5 pb-1.5">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t("channels.searchConversations")}
              isSearching={conversations.isFetching && !conversations.isPending}
            />
          </div>
          <div className="min-h-0 flex-1 px-1.5 pb-2 @2xl:overflow-y-auto">
            {conversations.isPending ? (
              LOADING_ROWS.map((k, i) => (
                <div key={k} className="flex items-center gap-3 px-2 py-2.5">
                  <Skeleton className="size-9 shrink-0 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton
                      className="h-3.5"
                      style={{ width: `${[55, 40, 70, 48][i % 4]}%` }}
                    />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              ))
            ) : conversations.isError ? (
              <p className="p-3 text-sm text-destructive">
                {conversations.error.message}
              </p>
            ) : rows.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                {query
                  ? t("channels.noConversationsMatch", { query })
                  : t("channels.noConversations")}
              </p>
            ) : (
              rows.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  aria-current={c.id === conversationId ? "true" : undefined}
                  onClick={() => onOpen(c)}
                  className={cn(
                    "focus-ring flex w-full min-w-0 items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors",
                    c.id === conversationId
                      ? "bg-accent"
                      : "hover:bg-accent/50",
                  )}
                >
                  <Avatar
                    fallback={c.title ?? c.id}
                    shape={squareFaces(connection.source) ? "square" : "circle"}
                    size="md"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                        {c.title ?? c.id}
                      </span>
                      {c.last_message_at && (
                        <span className="text-meta shrink-0">
                          {formatRelativeTime(
                            new Date(c.last_message_at),
                            language,
                          )}
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {c.kind !== "unknown"
                        ? c.kind
                        : channelName(connection.source)}
                    </span>
                  </span>
                </button>
              ))
            )}
            {conversations.hasNextPage && (
              <div className="flex justify-center py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={conversations.isFetchingNextPage}
                  onClick={() => void conversations.fetchNextPage()}
                >
                  {t("channels.loadMore")}
                </Button>
              </div>
            )}
          </div>
        </section>

        {/* What is open; with nothing open, the connection itself. */}
        <section
          className={cn(
            "min-h-0 min-w-0 flex-col @2xl:flex @2xl:flex-1",
            open
              ? "flex flex-1"
              : "order-first flex shrink-0 @2xl:order-none @2xl:shrink",
          )}
        >
          {conversationId ? (
            <Reader
              key={conversationId}
              connection={connection}
              conversationId={conversationId}
              conversation={current}
              onBack={() => onOpen(null)}
            />
          ) : (
            <Overview connection={connection} />
          )}
        </section>
      </div>
    </>
  );
}

function Overview({ connection }: { connection: Connection }) {
  const t = useT();
  const { org } = useProjectContext();
  const [{ language }] = usePreferences();
  const detail = useQuery({
    queryKey: KEYS.channelsConnection(org.id, connection.id),
    queryFn: () => getConnection(org.slug, connection.id),
    retry: (count, error) => !isUnknownTool(error) && count < 2,
  });
  const missing = isUnknownTool(detail.error);
  const data = detail.data;
  const lastEvent = data?.last_event_at ?? connection.last_event_at;
  const error = data?.sync.last_error ?? null;
  const ago = (iso: string) => formatRelativeTime(new Date(iso), language);
  const count = (n: number | undefined) =>
    n === undefined
      ? detail.isPending
        ? "…"
        : "—"
      : n.toLocaleString(language);

  const status = error
    ? { tone: "bg-destructive", label: t("channels.status.failing") }
    : lastEvent
      ? {
          tone: "bg-success",
          label: t("channels.status.receiving", { time: ago(lastEvent) }),
        }
      : { tone: "bg-muted-foreground/40", label: t("channels.status.waiting") };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 @2xl:overflow-y-auto @2xl:p-8">
      <header className="flex items-center gap-4">
        <ChannelMark source={connection.source} className="size-12" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold text-foreground">
            {connectionLabel(connection)}
          </h2>
          <p className="truncate text-sm text-muted-foreground">
            {channelName(connection.source)} · {connection.external_id}
          </p>
        </div>
      </header>

      <div className="flex items-center gap-2 text-sm">
        <span aria-hidden className={cn("size-2 rounded-full", status.tone)} />
        <span className="text-foreground">{status.label}</span>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>{t("channels.sync.errorTitle")}</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-3 gap-3">
        <MetricCard
          className="p-4"
          icon={<MessageChatSquare />}
          label={t("channels.count.conversations")}
          value={count(data?.counts.conversations)}
        />
        <MetricCard
          className="p-4"
          icon={<MessageTextSquare01 />}
          label={t("channels.count.messages")}
          value={count(data?.counts.messages)}
        />
        <MetricCard
          className="p-4"
          icon={<Users01 />}
          label={t("channels.count.people")}
          value={count(data?.counts.people)}
        />
      </div>
      {missing && (
        <p className="text-xs text-muted-foreground">
          {t("channels.detailUnavailable")}
        </p>
      )}
      {detail.isError && !missing && (
        <p className="text-xs text-destructive">
          {detail.error.message}{" "}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => void detail.refetch()}
          >
            {t("channels.retry")}
          </button>
        </p>
      )}

      <dl className="divide-y rounded-xl border text-sm">
        <Fact label={t("channels.fact.lastEvent")}>
          {lastEvent ? (
            <time
              dateTime={lastEvent}
              title={new Date(lastEvent).toLocaleString(language)}
            >
              {ago(lastEvent)}
            </time>
          ) : (
            t("channels.neverEvent")
          )}
        </Fact>
        <Fact label={t("channels.fact.sync")}>
          {data?.sync.source_cursor_at
            ? t("channels.sync.upTo", { time: ago(data.sync.source_cursor_at) })
            : t("channels.sync.none")}
        </Fact>
        <Fact label={t("channels.fact.created")}>
          {new Date(connection.created_at).toLocaleDateString(language, {
            dateStyle: "medium",
          })}
        </Fact>
        {connection.kind && (
          <Fact label={t("channels.fact.kind")}>{connection.kind}</Fact>
        )}
      </dl>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-foreground">
          {t("channels.ingest.title")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("channels.ingest.description")}
        </p>
        <div className="rounded-lg border">
          <CopySnippet
            label={t("channels.token.endpoint")}
            code={ingestUrl(org.id, connection.id)}
          />
        </div>
      </section>
    </div>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right text-foreground">
        {children}
      </dd>
    </div>
  );
}

/**
 * The open conversation in its channel's skin, newest at the bottom. The
 * scroller runs bottom-up (`flex-col-reverse`), so it opens on the newest
 * message and loading older ones above keeps what was on screen in place.
 */
function Reader({
  connection,
  conversationId,
  conversation,
  onBack,
}: {
  connection: Connection;
  conversationId: string;
  /** Its row in the list, when the list has it. */
  conversation: Conversation | undefined;
  onBack: () => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const studio = useStudioTools();

  const messages = useInfiniteQuery({
    queryKey: KEYS.channelsMessages(org.id, connection.id, conversationId),
    queryFn: ({ pageParam }) =>
      studio.call("CHANNELS_MESSAGE_LIST", {
        connection_id: connection.id,
        conversation_id: conversationId,
        before: pageParam,
        limit: 100,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_before ?? undefined,
  });
  const rows = messages.data?.pages.flatMap((p) => p.messages) ?? [];
  const skin = skinOf(connection.source);
  const title = conversation?.title ?? conversationId;
  const openLink = (url: string) => window.open(url, "_blank", "noopener");

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("channels.back")}
          className="text-muted-foreground @2xl:hidden"
          onClick={onBack}
        >
          <ChevronLeft size={16} />
        </Button>
        <Avatar
          fallback={title}
          shape={squareFaces(connection.source) ? "square" : "circle"}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">
            {title}
          </div>
          <div className="text-meta truncate">
            {[
              channelName(connection.source),
              conversation?.kind !== "unknown" ? conversation?.kind : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
        <div className="flex flex-1 flex-col *:flex-1">
          {messages.isPending ? (
            <div className="space-y-3 p-4">
              {["a", "b", "c", "d", "e"].map((k, i) => (
                <Skeleton
                  key={k}
                  className="h-10"
                  style={{ width: `${[45, 60, 35, 55, 40][i]}%` }}
                />
              ))}
            </div>
          ) : messages.isError ? (
            <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
              <p className="text-sm text-destructive">
                {messages.error.message}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void messages.refetch()}
              >
                {t("channels.retry")}
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <p className="flex items-center justify-center p-8 text-sm text-muted-foreground">
              {t("channels.noMessages")}
            </p>
          ) : (
            <ChatView
              skin={skin}
              messages={toChat(rows)}
              onOpen={openLink}
              renderText={
                skin === "transcript"
                  ? undefined
                  : (m) => <ChatText text={m.text ?? ""} open={openLink} />
              }
              header={
                messages.hasNextPage ? (
                  <div className="py-2 text-center">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={messages.isFetchingNextPage}
                      onClick={() => void messages.fetchNextPage()}
                    >
                      {t("channels.loadOlder")}
                    </Button>
                  </div>
                ) : null
              }
            />
          )}
        </div>
      </div>
    </>
  );
}
