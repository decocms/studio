import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { CreateConnectionDialog } from "@/web/components/connections/create-connection-dialog.tsx";
import type { RegistryItem } from "@/web/components/store/types";
import { authenticateAndPersistOAuth } from "@/web/lib/authenticate-and-persist-oauth";
import { KEYS } from "@/web/lib/query-keys";
import { authClient } from "@/web/lib/auth-client";
import { extractConnectionData } from "@/web/utils/extract-connection-data";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  type ConnectionEntity,
  useConnectionActions,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Loading01 } from "@untitledui/icons";
import { Suspense, useState } from "react";
import { toast } from "sonner";
import { track } from "@/web/lib/posthog-client";
import { ConnectionDialogContent } from "./connection-dialog-content.tsx";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConnectionDialogMode = "add" | "browse";

type AttachMode = "existing" | "clone" | "new" | "custom";

type ConnectionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: "all" | "connected";
  initialSearch?: string;
} & (
  | {
      mode?: "add";
      /** Agent ID for `agent_connection_attached` tracking. */
      agentId: string;
      addedConnectionIds: Set<string>;
      onAdd: (connectionId: string) => void;
    }
  | {
      mode: "browse";
      agentId?: undefined;
      addedConnectionIds?: undefined;
      onAdd?: undefined;
    }
);

// ---------------------------------------------------------------------------
// Main Dialog
// ---------------------------------------------------------------------------

export function AddConnectionDialog({
  open,
  onOpenChange,
  defaultTab,
  initialSearch = "",
  ...rest
}: ConnectionDialogProps) {
  const mode: ConnectionDialogMode = rest.mode ?? "add";
  const agentId = "agentId" in rest ? rest.agentId : undefined;
  const addedConnectionIds =
    "addedConnectionIds" in rest
      ? (rest.addedConnectionIds ?? new Set<string>())
      : new Set<string>();
  const onAdd =
    "onAdd" in rest && rest.onAdd ? rest.onAdd : (_id: string) => {};

  const trackAttach = (
    id: string,
    appName: string | null,
    attachMode: AttachMode,
  ) => {
    if (!agentId) return;
    track("agent_connection_attached", {
      agent_id: agentId,
      connection_id: id,
      app_name: appName,
      mode: attachMode,
    });
  };

  const [connectingItemId, setConnectingItemId] = useState<string | null>(null);
  const [search, setSearch] = useState(initialSearch);
  const [createOpen, setCreateOpen] = useState(false);
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const connectionActions = useConnectionActions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const handleBrowseNavigate = (slug: string) => {
    onOpenChange(false);
    navigate({
      to: "/$org/settings/connections/$appSlug",
      params: { org: org.slug, appSlug: slug },
    });
  };

  // Silent refresh of the connections collection after a successful OAuth
  // flow (no toast — just keeps cached connection/tool data fresh).
  const invalidateConnections = () => {
    queryClient.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey;
        return (
          key[1] === org.id &&
          key[3] === "collection" &&
          key[4] === "CONNECTIONS"
        );
      },
    });
  };

  // For connected apps: clone existing connection + add to agent
  const handleCloneAndAdd = async (base: ConnectionEntity) => {
    setConnectingItemId(base.app_name ?? base.id);
    try {
      const baseName = base.title.replace(/\s*\(\d+\)\s*$/, "");
      const newTitle = `${baseName} (${Date.now().toString(36).slice(-4)})`;

      const created = await connectionActions.create.mutateAsync({
        title: newTitle,
        description: base.description ?? null,
        connection_type: base.connection_type,
        connection_url: base.connection_url ?? null,
        connection_token: null,
        icon: base.icon ?? null,
        app_name: base.app_name ?? null,
        app_id: base.app_id ?? null,
        connection_headers: base.connection_headers ?? null,
      });
      const id = created.id;

      // Handle OAuth if needed + persist, via the shared helper.
      const auth = await authenticateAndPersistOAuth({
        connectionId: id,
        orgId: org.id,
        orgSlug: org.slug,
        persistFallback: (token) =>
          connectionActions.update
            .mutateAsync({ id, data: { connection_token: token } })
            .then(() => undefined),
      });

      if (auth.ran && !auth.ok) {
        track("connection_oauth_failed", {
          connection_id: id,
          flow: "clone",
          error: auth.error ?? "no_token",
        });
        toast.error(
          `Authentication failed: ${auth.error ?? "no token received"}`,
        );
        // Clean up the orphaned connection
        await connectionActions.delete.mutateAsync(id);
        return;
      }

      if (auth.ran) {
        track("connection_oauth_succeeded", {
          connection_id: id,
          flow: "clone",
        });
        const mcpProxyUrl = new URL(
          `/api/${org.slug}/mcp/${id}`,
          window.location.origin,
        );
        await queryClient.invalidateQueries({
          queryKey: KEYS.isMCPAuthenticated(mcpProxyUrl.href, null),
        });
        invalidateConnections();
      }

      trackAttach(id, base.app_name ?? null, "clone");
      onAdd(id);
    } catch (err) {
      console.error("Failed to add connection:", err);
      toast.error("Failed to add connection");
    } finally {
      setConnectingItemId(null);
    }
  };

  // For catalog items with no instances: create connection + add to agent
  const handleConnectAndAdd = async (item: RegistryItem) => {
    if (!org || !session?.user?.id) return;
    setConnectingItemId(item.id);

    try {
      const connectionData = extractConnectionData(
        item,
        org.id,
        session.user.id,
        { remoteIndex: 0 },
      );

      const isStdioConnection = connectionData.connection_type === "STDIO";
      const hasUrl = Boolean(connectionData.connection_url);
      const hasStdioConfig =
        isStdioConnection &&
        connectionData.connection_headers &&
        typeof connectionData.connection_headers === "object" &&
        "command" in connectionData.connection_headers;

      if (!hasUrl && !hasStdioConfig) {
        toast.error(
          "This MCP Server cannot be connected: no connection method available",
        );
        setConnectingItemId(null);
        return;
      }

      const { id } = await connectionActions.create.mutateAsync(connectionData);

      // Handle OAuth flow (if needed) + persist, via the shared helper.
      const auth = await authenticateAndPersistOAuth({
        connectionId: id,
        orgId: org.id,
        orgSlug: org.slug,
        persistFallback: (token) =>
          connectionActions.update
            .mutateAsync({ id, data: { connection_token: token } })
            .then(() => undefined),
      });

      if (auth.ran && !auth.ok) {
        track("connection_oauth_failed", {
          connection_id: id,
          flow: "connect_new",
          error: auth.error ?? "no_token",
        });
        toast.warning("Couldn't sign in to this connection", {
          description: `It was added to your agent, but its sign-in setup looks off. You can try authenticating again later from the connection's settings. (${auth.error ?? "no token received"})`,
        });
        trackAttach(id, connectionData.app_name ?? null, "new");
        onAdd(id);
        return;
      }

      if (auth.ran) {
        track("connection_oauth_succeeded", {
          connection_id: id,
          flow: "connect_new",
        });
        const mcpProxyUrl = new URL(
          `/api/${org.slug}/mcp/${id}`,
          window.location.origin,
        );
        await queryClient.invalidateQueries({
          queryKey: KEYS.isMCPAuthenticated(mcpProxyUrl.href, null),
        });
        invalidateConnections();
        toast.success("Connected and authenticated");
      } else {
        toast.success("Connected");
      }

      trackAttach(id, connectionData.app_name ?? null, "new");
      onAdd(id);
    } catch (err) {
      console.error("Failed to connect:", err);
      toast.error("Failed to connect");
    } finally {
      setConnectingItemId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl h-[85vh] max-h-[85vh] flex flex-col p-0 gap-0 overflow-hidden w-[95vw]">
        <DialogHeader className="px-6 pt-5 pb-0 shrink-0">
          <DialogTitle className="text-base font-semibold">
            {mode === "browse" ? "Connections" : "Add Connection"}
          </DialogTitle>
        </DialogHeader>

        <div className="pt-3 shrink-0">
          <CollectionSearch
            value={search}
            onChange={setSearch}
            placeholder="Search connections..."
          />
        </div>

        <Suspense
          fallback={
            <div className="flex-1 flex items-center justify-center">
              <Loading01
                size={24}
                className="animate-spin text-muted-foreground"
              />
            </div>
          }
        >
          <ConnectionDialogContent
            mode={mode}
            agentId={agentId}
            addedConnectionIds={addedConnectionIds}
            onAdd={onAdd}
            onCloneAndAdd={handleCloneAndAdd}
            onConnectAndAdd={handleConnectAndAdd}
            connectingItemId={connectingItemId}
            search={search}
            onCreateConnection={() => setCreateOpen(true)}
            onBrowseNavigate={handleBrowseNavigate}
            defaultTab={defaultTab}
          />
        </Suspense>
      </DialogContent>

      <CreateConnectionDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={async (id) => {
          setCreateOpen(false);

          // Handle OAuth if needed + persist, via the shared helper.
          const auth = await authenticateAndPersistOAuth({
            connectionId: id,
            orgId: org.id,
            orgSlug: org.slug,
            persistFallback: (token) =>
              connectionActions.update
                .mutateAsync({ id, data: { connection_token: token } })
                .then(() => undefined),
          });

          if (auth.ran && !auth.ok) {
            track("connection_oauth_failed", {
              connection_id: id,
              flow: "custom_create",
              error: auth.error ?? "no_token",
            });
            toast.warning("Couldn't sign in to this connection", {
              description: `It was added to your agent, but its sign-in setup looks off. You can try authenticating again later from the connection's settings. (${auth.error ?? "no token received"})`,
            });
            trackAttach(id, null, "custom");
            onAdd(id);
            onOpenChange(false);
            return;
          }

          if (auth.ran) {
            track("connection_oauth_succeeded", {
              connection_id: id,
              flow: "custom_create",
            });
            const mcpProxyUrl = new URL(
              `/api/${org.slug}/mcp/${id}`,
              window.location.origin,
            );
            await queryClient.invalidateQueries({
              queryKey: KEYS.isMCPAuthenticated(mcpProxyUrl.href, null),
            });
            invalidateConnections();
          }

          // app_name unknown for custom-create; record null and let the
          // server-side connection_created backfill the breakdown.
          trackAttach(id, null, "custom");
          onAdd(id);
          onOpenChange(false);
        }}
      />
    </Dialog>
  );
}
