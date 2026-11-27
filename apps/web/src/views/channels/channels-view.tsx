/**
 * Context → Channels: the org's channel connections (a WhatsApp number, a
 * Discord bot…), and, inside one, what it brought in, read the way the
 * channels hub reads it (connection-view.tsx). Where you are lives in the
 * search params (`?connection=`, `?conversation=`), so a link opens the same
 * conversation and the breadcrumb and the back button walk back up.
 */
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  AlertTriangle,
  DotsVertical,
  MessageChatSquare,
  Plus,
} from "@untitledui/icons";
import { type ReactNode, useState } from "react";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { ListRow } from "@decocms/ui/components/list-row.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { EmptyState } from "@/components/empty-state.tsx";
import { Page } from "@/components/page";
import { useOrgFlagState } from "@/hooks/use-organization-settings";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useT } from "@/i18n/use-t.ts";
import { channelName } from "@/lib/channel-accounts";
import { formatRelativeTime } from "@/lib/format-time";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";
import { ChannelMark } from "./channel-mark.tsx";
import {
  ConnectDialog,
  type Connection,
  ConnectionConfirm,
  connectionLabel,
  type Secret,
  TokenOnceDialog,
} from "./connection-dialogs.tsx";
import { ConnectionView } from "./connection-view.tsx";

function Loading() {
  return (
    <div className="flex h-40 items-center justify-center">
      <Spinner className="size-5 text-muted-foreground" />
    </div>
  );
}

function DocumentPage({ children }: { children: ReactNode }) {
  return (
    <Page>
      <Page.Content>
        <Page.Container width="standard">{children}</Page.Container>
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
      <DocumentPage>
        <EmptyState
          image={
            <MessageChatSquare size={48} className="text-muted-foreground" />
          }
          title={t("channels.unavailableTitle")}
          description={t("channels.unavailableDescription")}
        />
      </DocumentPage>
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
  const [secret, setSecret] = useState<Secret | null>(null);
  // The connection stays while its dialog closes, so the title never empties.
  const [target, setTarget] = useState<Connection | null>(null);
  const [confirm, setConfirm] = useState<"rotate" | "delete" | null>(null);

  const go = (next: { connection?: string; conversation?: string }) =>
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
  const connectionId = search.connection;
  const current = list.find((c) => c.id === connectionId);

  const ask = (c: Connection, action: "rotate" | "delete") => {
    setTarget(c);
    setConfirm(action);
  };

  const crumbs = [];
  if (connectionId) {
    crumbs.push({
      key: "channels-connection",
      label: current ? connectionLabel(current) : connectionId,
      onSelect: () => go({ connection: connectionId }),
    });
  }

  const connectButton = (
    <Button size="sm" variant="brand" onClick={() => setConnecting(true)}>
      <Plus size={14} />
      {t("channels.connect")}
    </Button>
  );

  const dialogs = (
    <>
      <ConnectDialog
        open={connecting}
        onOpenChange={setConnecting}
        onCreated={(created) => {
          setConnecting(false);
          setSecret(created);
        }}
      />
      <TokenOnceDialog secret={secret} onClose={() => setSecret(null)} />
      <ConnectionConfirm
        action={confirm}
        connection={target}
        onClose={() => setConfirm(null)}
        onToken={setSecret}
        onDeleted={() => {
          if (target?.id === connectionId) go({});
        }}
      />
    </>
  );

  const breadcrumbs = (
    <Page.Breadcrumbs
      after="context-section"
      parent={{ onSelect: () => go({}) }}
      items={crumbs}
    />
  );

  // Inside a connection: the hub's panes, filling the section.
  if (connectionId) {
    return (
      <>
        {breadcrumbs}
        {current && (
          <Page.Actions>
            <ConnectionMenu
              onRotate={() => ask(current, "rotate")}
              onDelete={() => ask(current, "delete")}
            />
          </Page.Actions>
        )}
        {current ? (
          <ConnectionView
            key={current.id}
            connection={current}
            conversationId={search.conversation}
            onOpen={(c) => go({ connection: current.id, conversation: c?.id })}
          />
        ) : connections.isPending ? (
          <Loading />
        ) : (
          <DocumentPage>
            <EmptyState
              image={
                <MessageChatSquare
                  size={48}
                  className="text-muted-foreground"
                />
              }
              title={t("channels.notFoundTitle")}
              description={t("channels.notFoundDescription")}
              actions={
                <Button size="sm" variant="outline" onClick={() => go({})}>
                  {t("channels.allConnections")}
                </Button>
              }
            />
          </DocumentPage>
        )}
        {dialogs}
      </>
    );
  }

  return (
    <DocumentPage>
      {breadcrumbs}
      {list.length > 0 && <Page.Actions>{connectButton}</Page.Actions>}
      {connections.isPending ? (
        <ConnectionsSkeleton />
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
          onOpen={(id) => go({ connection: id })}
          onAsk={ask}
        />
      )}
      {dialogs}
    </DocumentPage>
  );
}

function ConnectionMenu({
  onRotate,
  onDelete,
}: {
  onRotate: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  return (
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
        <DropdownMenuItem onSelect={onRotate}>
          {t("channels.rotateToken")}
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          {t("channels.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ConnectionsSkeleton() {
  return (
    <div className="flex flex-col">
      {["a", "b", "c"].map((k) => (
        <div key={k} className="flex items-center gap-3 border-b py-3">
          <Skeleton className="size-8 rounded-[27%]" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-48" />
            <Skeleton className="h-3 w-32" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Each connection: its mark, its name, where it is at the source, how fresh it is. */
function ConnectionList({
  connections,
  onOpen,
  onAsk,
}: {
  connections: Connection[];
  onOpen: (id: string) => void;
  onAsk: (c: Connection, action: "rotate" | "delete") => void;
}) {
  const t = useT();
  const [{ language }] = usePreferences();
  return (
    <ul className="flex flex-col">
      {connections.map((c) => (
        <li
          key={c.id}
          className="flex items-center gap-1 border-b last:border-b-0"
        >
          <ListRow
            asChild
            lead={<ChannelMark source={c.source} />}
            title={
              <span className="font-medium text-foreground">
                {connectionLabel(c)}
              </span>
            }
            meta={
              c.name
                ? `${channelName(c.source)} · ${c.external_id}`
                : channelName(c.source)
            }
            trailing={
              <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 rounded-full",
                    c.last_event_at ? "bg-success" : "bg-muted-foreground/40",
                  )}
                />
                {c.last_event_at
                  ? t("channels.lastEvent", {
                      time: formatRelativeTime(
                        new Date(c.last_event_at),
                        language,
                      ),
                    })
                  : t("channels.neverEvent")}
              </span>
            }
            className="py-3"
          >
            <button type="button" onClick={() => onOpen(c.id)} />
          </ListRow>
          <ConnectionMenu
            onRotate={() => onAsk(c, "rotate")}
            onDelete={() => onAsk(c, "delete")}
          />
        </li>
      ))}
    </ul>
  );
}
