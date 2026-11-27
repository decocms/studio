/**
 * Context → Channels: the org's channel connections (a WhatsApp number, a
 * Discord bot…), what each one brought in, and its messages. One view that
 * drills down through `?connection=` and `?conversation=`, so a link opens the
 * same conversation and the browser's back button walks back up.
 */

import { type ReactNode, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  AlertTriangle,
  Copy01,
  DotsVertical,
  MessageChatSquare,
  Plus,
} from "@untitledui/icons";
import type { StudioToolIO } from "@decocms/shared/tools/tool-io";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { SearchInput } from "@decocms/ui/components/search-input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { toast } from "@decocms/ui/components/sonner.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { EmptyState } from "@/components/empty-state.tsx";
import { Page } from "@/components/page";
import { useDebouncedValue } from "@/hooks/use-debounced-value.ts";
import { useOrgFlagState } from "@/hooks/use-organization-settings";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useT } from "@/i18n/use-t.ts";
import { channelName } from "@/lib/channel-accounts";
import { formatRelativeTime } from "@/lib/format-time";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";

type Connection =
  StudioToolIO["CHANNELS_CONNECTION_LIST"]["output"]["connections"][number];
type Message =
  StudioToolIO["CHANNELS_MESSAGE_LIST"]["output"]["messages"][number];

/** CHANNELS_CONNECTION_CREATE's sources, in the order the select offers them. */
const SOURCES = [
  "whatsapp",
  "discord",
  "slack",
  "grain",
  "gchat",
  "teams",
] as const;
type Source = (typeof SOURCES)[number];

const ROWS = "divide-y divide-border rounded-xl border border-border";
const ROW_BUTTON =
  "flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-accent/50";

const connectionLabel = (c: Connection) => c.name ?? c.external_id;

function Loading() {
  return (
    <div className="flex h-40 items-center justify-center">
      <Spinner className="size-5 text-muted-foreground" />
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <Page>
      <Page.Content>
        <Page.Container width="standard">
          <div className="flex flex-col gap-4">{children}</div>
        </Page.Container>
      </Page.Content>
    </Page>
  );
}

/** The org flag gates the screen; the API refuses on its own when it's off. */
export default function ChannelsView() {
  const t = useT();
  const enabled = useOrgFlagState("channels_enabled");
  if (enabled === undefined) return <Loading />;
  if (!enabled) {
    return (
      <Shell>
        <EmptyState
          image={
            <MessageChatSquare size={48} className="text-muted-foreground" />
          }
          title={t("channels.unavailableTitle")}
          description={t("channels.unavailableDescription")}
        />
      </Shell>
    );
  }
  return <ChannelsBrowser />;
}

function ChannelsBrowser() {
  const t = useT();
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as {
    connection?: string;
    conversation?: string;
  };
  const [connecting, setConnecting] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  // The title of the conversation last opened from the list; a pasted link
  // has only the id until it is opened from the list again.
  const [opened, setOpened] = useState<{ id: string; title: string } | null>(
    null,
  );

  const open = (next: { connection?: string; conversation?: string }) =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        connection: next.connection,
        conversation: next.conversation,
      }),
    });

  const connections = useQuery({
    queryKey: KEYS.channelsConnections(org.id),
    queryFn: () => studio.call("CHANNELS_CONNECTION_LIST", {}),
  });
  const list = connections.data?.connections ?? [];
  const current = list.find((c) => c.id === search.connection);
  const connectionId = search.connection;

  const crumbs = [];
  if (connectionId) {
    crumbs.push({
      key: "channels-connection",
      label: current ? connectionLabel(current) : connectionId,
      onSelect: () => open({ connection: connectionId }),
    });
    if (search.conversation) {
      crumbs.push({
        key: "channels-conversation",
        label:
          opened?.id === search.conversation
            ? opened.title
            : search.conversation,
      });
    }
  }

  const connectButton = (
    <Button size="sm" variant="brand" onClick={() => setConnecting(true)}>
      <Plus size={14} />
      {t("channels.connect")}
    </Button>
  );

  return (
    <Shell>
      <Page.Breadcrumbs
        after="context-section"
        parent={{ onSelect: () => open({}) }}
        items={crumbs}
      />
      {!connectionId && <Page.Actions>{connectButton}</Page.Actions>}

      {connectionId && search.conversation ? (
        <Messages
          key={`${connectionId}:${search.conversation}`}
          connectionId={connectionId}
          conversationId={search.conversation}
        />
      ) : connectionId ? (
        <Conversations
          key={connectionId}
          connectionId={connectionId}
          onOpen={(conversation) => {
            setOpened({
              id: conversation.id,
              title: conversation.title ?? conversation.id,
            });
            open({ connection: connectionId, conversation: conversation.id });
          }}
        />
      ) : connections.isPending ? (
        <Loading />
      ) : connections.isError ? (
        <EmptyState
          image={<AlertTriangle size={48} className="text-muted-foreground" />}
          title={t("channels.errorTitle")}
          description={connections.error.message}
          actions={
            <Button
              size="sm"
              variant="outline"
              onClick={() => void connections.refetch()}
            >
              {t("channels.retry")}
            </Button>
          }
        />
      ) : list.length === 0 ? (
        <EmptyState
          image={
            <MessageChatSquare size={48} className="text-muted-foreground" />
          }
          title={t("channels.emptyTitle")}
          description={t("channels.emptyDescription")}
          actions={connectButton}
        />
      ) : (
        <ConnectionList
          connections={list}
          onOpen={(id) => open({ connection: id })}
          onToken={setToken}
        />
      )}

      <ConnectDialog
        open={connecting}
        onOpenChange={setConnecting}
        onCreated={(created) => {
          setConnecting(false);
          setToken(created);
        }}
      />
      <TokenOnceDialog token={token} onClose={() => setToken(null)} />
    </Shell>
  );
}

function ConnectionList({
  connections,
  onOpen,
  onToken,
}: {
  connections: Connection[];
  onOpen: (id: string) => void;
  onToken: (token: string) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const [{ language }] = usePreferences();
  // The connection stays while a dialog closes, so its title never empties.
  const [target, setTarget] = useState<Connection | null>(null);
  const [confirm, setConfirm] = useState<"rotate" | "delete" | null>(null);

  const rotate = useMutation({
    mutationFn: (id: string) =>
      studio.call("CHANNELS_CONNECTION_ROTATE_TOKEN", { id }),
    onSuccess: ({ token }) => onToken(token),
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      studio.call("CHANNELS_CONNECTION_DELETE", { id }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: KEYS.channels(org.id) });
      toast.success(t("channels.deleted"));
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const ask = (c: Connection, action: "rotate" | "delete") => {
    setTarget(c);
    setConfirm(action);
  };
  const name = target ? connectionLabel(target) : "";

  return (
    <>
      <div className={ROWS}>
        {connections.map((c) => (
          <div key={c.id} className="flex items-center pr-2">
            <button
              type="button"
              className={ROW_BUTTON}
              onClick={() => onOpen(c.id)}
            >
              <span className="w-28 shrink-0 text-muted-foreground">
                {channelName(c.source)}
              </span>
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="truncate font-medium text-foreground">
                  {connectionLabel(c)}
                </span>
                {c.name && (
                  <span className="truncate text-xs text-muted-foreground">
                    {c.external_id}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {c.last_event_at
                  ? t("channels.lastEvent", {
                      time: formatRelativeTime(
                        new Date(c.last_event_at),
                        language,
                      ),
                    })
                  : t("channels.neverEvent")}
              </span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("channels.rowMenu")}
                >
                  <DotsVertical size={14} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => ask(c, "rotate")}>
                  {t("channels.rotateToken")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => ask(c, "delete")}
                >
                  {t("channels.delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </div>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "delete"
                ? t("channels.delete.title", { name })
                : t("channels.rotate.title", { name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "delete"
                ? t("channels.delete.description")
                : t("channels.rotate.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("channels.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant={confirm === "delete" ? "destructive" : "default"}
              onClick={() => {
                if (!target) return;
                if (confirm === "delete") remove.mutate(target.id);
                else rotate.mutate(target.id);
              }}
            >
              {confirm === "delete"
                ? t("channels.delete")
                : t("channels.rotateToken")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ConnectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (token: string) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const [source, setSource] = useState<Source>("whatsapp");
  const [externalId, setExternalId] = useState("");
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: () =>
      studio.call("CHANNELS_CONNECTION_CREATE", {
        source,
        external_id: externalId.trim(),
        name: name.trim() || undefined,
      }),
    onSuccess: async ({ token }) => {
      setExternalId("");
      setName("");
      onCreated(token);
      await queryClient.invalidateQueries({
        queryKey: KEYS.channelsConnections(org.id),
      });
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) create.reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (externalId.trim()) create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("channels.form.title")}</DialogTitle>
            <DialogDescription>
              {t("channels.form.description")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="channel-source">{t("channels.form.source")}</Label>
            <Select
              value={source}
              onValueChange={(v) => setSource(v as Source)}
            >
              <SelectTrigger id="channel-source" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {channelName(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="channel-external-id">
              {t("channels.form.externalId")}
            </Label>
            <Input
              id="channel-external-id"
              required
              maxLength={512}
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("channels.form.externalIdHint")}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="channel-name">{t("channels.form.name")}</Label>
            <Input
              id="channel-name"
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {create.isError && (
            <p role="alert" className="text-sm text-destructive">
              {create.error.message}
            </p>
          )}
          <DialogFooter>
            <Button
              type="submit"
              disabled={!externalId.trim() || create.isPending}
            >
              {create.isPending
                ? t("channels.form.submitting")
                : t("channels.form.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A connection's ingestion token, shown once: closing the dialog drops it. */
function TokenOnceDialog({
  token,
  onClose,
}: {
  token: string | null;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Dialog open={token !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("channels.token.title")}</DialogTitle>
          <DialogDescription>
            {t("channels.token.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input readOnly value={token ?? ""} className="font-mono text-xs" />
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t("channels.token.copy")}
            onClick={() => {
              if (!token) return;
              navigator.clipboard?.writeText(token);
              toast.success(t("channels.token.copied"));
            }}
          >
            <Copy01 size={14} />
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{t("channels.token.done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Conversations({
  connectionId,
  onOpen,
}: {
  connectionId: string;
  onOpen: (conversation: { id: string; title: string | null }) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const [{ language }] = usePreferences();
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim(), 300);

  const conversations = useInfiniteQuery({
    queryKey: KEYS.channelsConversations(org.id, connectionId, query),
    queryFn: ({ pageParam }) =>
      studio.call("CHANNELS_CONVERSATION_LIST", {
        connection_id: connectionId,
        query: query || undefined,
        cursor: pageParam,
        limit: 50,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = conversations.data?.pages.flatMap((p) => p.conversations) ?? [];

  return (
    <>
      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder={t("channels.searchConversations")}
        isSearching={conversations.isFetching && !conversations.isPending}
        className="max-w-sm"
      />
      {conversations.isPending ? (
        <Loading />
      ) : conversations.isError ? (
        <p className="text-sm text-destructive">
          {conversations.error.message}
        </p>
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {query
            ? t("channels.noConversationsMatch", { query })
            : t("channels.noConversations")}
        </p>
      ) : (
        <div className={ROWS}>
          {rows.map((c) => (
            <button
              key={c.id}
              type="button"
              className={cn(ROW_BUTTON, "w-full")}
              onClick={() => onOpen(c)}
            >
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {c.title ?? c.id}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {c.kind}
              </span>
              <span className="w-32 shrink-0 text-right text-xs text-muted-foreground">
                {c.last_message_at
                  ? formatRelativeTime(new Date(c.last_message_at), language)
                  : ""}
              </span>
            </button>
          ))}
        </div>
      )}
      {conversations.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          className="self-center"
          disabled={conversations.isFetchingNextPage}
          onClick={() => void conversations.fetchNextPage()}
        >
          {t("channels.loadMore")}
        </Button>
      )}
    </>
  );
}

const attachmentCount = (m: Message) =>
  Array.isArray(m.attachments) ? m.attachments.length : 0;

function Messages({
  connectionId,
  conversationId,
}: {
  connectionId: string;
  conversationId: string;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const [{ language }] = usePreferences();

  const messages = useInfiniteQuery({
    queryKey: KEYS.channelsMessages(org.id, connectionId, conversationId),
    queryFn: ({ pageParam }) =>
      studio.call("CHANNELS_MESSAGE_LIST", {
        connection_id: connectionId,
        conversation_id: conversationId,
        before: pageParam,
        limit: 50,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_before ?? undefined,
  });
  const rows = messages.data?.pages.flatMap((p) => p.messages) ?? [];
  const when = (ts: string) =>
    new Date(ts).toLocaleString(language, {
      dateStyle: "short",
      timeStyle: "short",
    });

  if (messages.isPending) return <Loading />;
  if (messages.isError) {
    return <p className="text-sm text-destructive">{messages.error.message}</p>;
  }
  if (rows.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        {t("channels.noMessages")}
      </p>
    );
  }

  return (
    <>
      {/* Newest first, like the tool reads them; older ones load below. */}
      <ol className={ROWS}>
        {rows.map((m) => {
          const files = attachmentCount(m);
          return (
            <li key={m.id} className="flex flex-col gap-1 px-4 py-2.5 text-sm">
              <div className="flex items-baseline gap-2">
                <span className="truncate font-medium text-foreground">
                  {m.author_name ?? m.author_id ?? t("channels.unknownAuthor")}
                </span>
                <time
                  dateTime={m.ts}
                  className="shrink-0 text-xs text-muted-foreground"
                >
                  {when(m.ts)}
                </time>
              </div>
              {m.deleted_at ? (
                <p className="text-muted-foreground italic">
                  {t("channels.messageDeleted")}
                </p>
              ) : (
                <>
                  {m.text && (
                    <p className="whitespace-pre-wrap break-words text-foreground">
                      {m.text}
                    </p>
                  )}
                  {m.derived_text && (
                    <p className="whitespace-pre-wrap break-words text-muted-foreground">
                      {m.derived_text}
                    </p>
                  )}
                  {files > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {files === 1
                        ? t("channels.attachmentsOne")
                        : t("channels.attachments", { count: files })}
                    </p>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ol>
      {messages.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          className="self-center"
          disabled={messages.isFetchingNextPage}
          onClick={() => void messages.fetchNextPage()}
        >
          {t("channels.loadOlder")}
        </Button>
      )}
    </>
  );
}
