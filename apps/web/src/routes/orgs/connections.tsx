import { generatePrefixedId } from "@decocms/shared/utils/generate-id";
import { CollectionDisplayButton } from "@/components/collections/collection-display-button.tsx";
import { SearchInput } from "@deco/ui/components/search-input.tsx";
import { useT } from "@/i18n/use-t";
import { CollectionTabs } from "@/components/collections/collection-tabs.tsx";
import { ConnectionCard } from "@/components/connections/connection-card.tsx";
import { EmptyState } from "@/components/empty-state.tsx";
import { ErrorBoundary } from "@/components/error-boundary";
import { Page } from "@/components/page";
import type { RegistryItem } from "@/components/store/types";
import { DeleteConnectionDialogs } from "@/components/delete-connection-dialogs";
import { useDeleteConnection } from "@/hooks/use-delete-connection";
import { useCapability } from "@/hooks/use-capability";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { useEnabledRegistries } from "@/hooks/use-enabled-registries";
import { useListState } from "@/hooks/use-list-state";
import { authClient } from "@/lib/auth-client";
import { useAuthConfig } from "@/providers/auth-config-provider";
import { useMergedStoreDiscovery } from "@/hooks/use-merged-store-discovery";
import { getConnectionSlug } from "@decocms/shared/utils/connection-slug";
import { BulkDeleteDialog } from "./bulk-delete-dialog.tsx";
import { CatalogItemCard } from "./catalog-item-card.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@deco/ui/components/drawer.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@deco/ui/components/form.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  useConnectionActions,
  useConnections,
  useProjectContext,
  type ConnectionEntity,
  useVirtualMCPs,
} from "@/sdk";
import { useStudioTools } from "@/lib/studio-tools";
import { toast } from "sonner";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  Container,
  Globe02,
  Loading01,
  Plus,
  Terminal,
  XClose,
} from "@untitledui/icons";
import { Suspense, useState } from "react";
import { useForm } from "react-hook-form";
import { track } from "@/lib/posthog-client";
import {
  connectionFormSchema,
  type ConnectionFormData,
} from "@/components/details/connection/settings-tab/schema";

import type {
  HttpConnectionParameters,
  StdioConnectionParameters,
} from "@decocms/shared/sdk/types";
import { EnvVarsEditor } from "@/components/env-vars-editor";
import {
  extractConnectionData,
  getRegistryItemAppName,
} from "@/utils/extract-connection-data";
import { authenticateAndPersistOAuth } from "@/lib/authenticate-and-persist-oauth";
import { KEYS } from "@/lib/query-keys";
import {
  type ConnectionProviderHint,
  buildCustomStdioParameters,
  buildNpxParameters,
  inferHardcodedProviderHint,
  inferRegistryProviderHint,
  parseNpxLikeCommand,
} from "@/utils/connection-form-helpers";

// ---------------------------------------------------------------------------
// Grouping helpers (shared with agent add-connection dialog)
// ---------------------------------------------------------------------------

import { groupConnections } from "@/utils/group-connections";
import {
  AddToAgentDialog,
  BulkActionBar,
  ConnectionCardHeaderActions,
  ConnectionGroupCard,
} from "./connection-selection-ui.tsx";

// ---------------------------------------------------------------------------
// Connection type / status filter types
// ---------------------------------------------------------------------------

type ConnectionTypeFilter = "ALL" | "HTTP" | "SSE" | "Websocket" | "STDIO";

type ConnectionStatusFilter = "ALL" | "active" | "inactive" | "error";

// ===========================================================================

// ---------------------------------------------------------------------------
// ListState import type alias (re-exported for convenience)
// ---------------------------------------------------------------------------
import type { ListState } from "@/hooks/use-list-state";

// ---------------------------------------------------------------------------
// ConnectionResults props
// ---------------------------------------------------------------------------

interface ConnectionResultsProps {
  listState: ListState<ConnectionEntity>;
  activeTab: "connected" | "all";
  typeFilter: ConnectionTypeFilter;
  statusFilter: ConnectionStatusFilter;
  registryFilter: string;
  enabledRegistries: Array<{ id: string; title: string; icon: string | null }>;
}

// ---------------------------------------------------------------------------
// ConnectionResults — inner component wrapped in Suspense
// ---------------------------------------------------------------------------

function ConnectionResults({
  listState,
  activeTab,
  typeFilter,
  statusFilter,
  registryFilter,
  enabledRegistries,
}: ConnectionResultsProps) {
  const t = useT();
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();

  const actions = useConnectionActions();
  const connections = useConnections(listState);

  const deleteConnection = useDeleteConnection();
  const { granted: canManage } = useCapability("connections:manage");
  const { granted: canManageAgents } = useCapability("agents:manage");

  // Selection / bulk-action state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectionMode = selectedIds.size > 0;
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [addToAgentOpen, setAddToAgentOpen] = useState(false);

  // Inline connect state
  const [connectingItemId, setConnectingItemId] = useState<string | null>(null);

  // Agents list (for Add to Agent dialog)
  const agents = useVirtualMCPs();

  // Apply UI filters (VIRTUAL already excluded server-side)
  const filteredConnections = connections.filter((c) => {
    if (typeFilter !== "ALL" && c.connection_type !== typeFilter) return false;
    if (statusFilter !== "ALL" && c.status !== statusFilter) return false;
    return true;
  });

  const grouped = groupConnections(filteredConnections);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitSelectionMode = () => {
    setSelectedIds(new Set());
  };

  // Registry / catalog - merge all enabled registries (server-side search)
  const mergedDiscovery = useMergedStoreDiscovery(
    enabledRegistries,
    listState.searchTerm,
  );
  const registryItems = mergedDiscovery.items;

  const catalogSentinelRef = useInfiniteScroll(
    mergedDiscovery.loadMore,
    mergedDiscovery.hasMore,
    mergedDiscovery.isLoadingMore,
  );

  // "All" tab: catalog items from registry (includes already-connected ones)
  const connectedAppNames = new Set(
    connections.filter((c) => c.app_name).map((c) => c.app_name as string),
  );

  // Reset registry filter if the selected registry is no longer enabled
  const effectiveRegistryFilter =
    registryFilter === "ALL" ||
    enabledRegistries.some((r) => r.id === registryFilter)
      ? registryFilter
      : "ALL";

  const isSearching = listState.search.length > 0;

  // Catalog items: show on "All" tab always, or on "Connected" tab when searching
  const catalogItems =
    activeTab === "all" || isSearching
      ? registryItems.filter((item) => {
          if (
            effectiveRegistryFilter !== "ALL" &&
            item._registryId !== effectiveRegistryFilter
          ) {
            return false;
          }
          // Exclude already-connected items to avoid duplicates with groupedForDisplay
          if (isSearching) {
            const appName = getRegistryItemAppName(item);
            if (appName && connectedAppNames.has(appName)) return false;
          }
          return true;
        })
      : [];

  // Connected items: show on "Connected" tab always, or on "All" tab when searching
  // When both show, connected always appear first in the grid
  const groupedForDisplay =
    activeTab === "connected" || isSearching ? grouped : [];

  const handleInlineConnect = async (item: RegistryItem) => {
    if (!org || !session?.user?.id) return;
    track("connection_add_clicked", {
      action: "connect_new",
      registry_item_id: item.id,
      source: "connections_page",
    });
    setConnectingItemId(item.id);

    try {
      const connectionData = extractConnectionData(
        item,
        org.id,
        session.user.id,
        { remoteIndex: 0 },
      );

      // Validate connection data
      const isStdioConnection = connectionData.connection_type === "STDIO";
      const hasUrl = Boolean(connectionData.connection_url);
      const hasStdioConfig =
        isStdioConnection &&
        connectionData.connection_headers &&
        typeof connectionData.connection_headers === "object" &&
        "command" in connectionData.connection_headers;

      if (!hasUrl && !hasStdioConfig) {
        toast.error(t("orgs.connections.cannotConnectNoMethod"));
        setConnectingItemId(null);
        return;
      }

      const { id } = await actions.create.mutateAsync(connectionData);

      // Handle OAuth flow (if needed) + persist, via the shared helper.
      const auth = await authenticateAndPersistOAuth({
        connectionId: id,
        orgId: org.id,
        orgSlug: org.slug,
        persistFallback: (token) =>
          actions.update
            .mutateAsync({ id, data: { connection_token: token } })
            .then(() => undefined),
      });

      if (auth.ran && !auth.ok) {
        track("connection_oauth_failed", {
          connection_id: id,
          flow: "connections_page_connect",
          error: auth.error ?? "no_token",
        });
        toast.error(
          t("orgs.connections.authenticationFailed", {
            error: auth.error ?? "no token received",
          }),
        );
        return;
      }

      if (auth.ran) {
        track("connection_oauth_succeeded", {
          connection_id: id,
          flow: "connections_page_connect",
        });
        const mcpProxyUrl = new URL(
          `/api/${org.slug}/mcp/${id}`,
          window.location.origin,
        );
        await queryClient.invalidateQueries({
          queryKey: KEYS.isMCPAuthenticated(mcpProxyUrl.href, null),
        });
        invalidateConnections();
        toast.success(t("orgs.connections.authenticationSuccessful"));
      }

      toast.success(t("orgs.connections.connectedSuccessfully"));
    } catch (error) {
      toast.error(
        t("orgs.connections.failedToConnect", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setConnectingItemId(null);
    }
  };

  const studio = useStudioTools();

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

  // Bulk action handlers
  const handleBulkDelete = async () => {
    setBulkDeleteOpen(false);
    const ids = [...selectedIds];
    track("connections_bulk_delete", { count: ids.length });
    let deleted = 0;

    for (const id of ids) {
      try {
        await studio.call("COLLECTION_CONNECTIONS_DELETE", { id, force: true });
        deleted++;
      } catch {
        // continue with next
      }
    }

    invalidateConnections();
    toast.success(t("orgs.connections.deletedConnections", { count: deleted }));
    exitSelectionMode();
  };

  const handleToggleStatus = async (
    id: string,
    status: "active" | "inactive",
  ) => {
    try {
      await actions.update.mutateAsync({ id, data: { status } });
      invalidateConnections();
      toast.success(
        status === "active"
          ? t("orgs.connections.connectionEnabled")
          : t("orgs.connections.connectionDisabled"),
      );
    } catch {
      toast.error(t("orgs.connections.failedToUpdateConnection"));
    }
  };

  const handleBulkToggleStatus = async (status: "active" | "inactive") => {
    const ids = [...selectedIds];
    track("connections_bulk_status_toggled", {
      count: ids.length,
      to_status: status,
    });
    let updated = 0;

    for (const id of ids) {
      try {
        await actions.update.mutateAsync({ id, data: { status } });
        updated++;
      } catch {
        // continue
      }
    }

    invalidateConnections();
    toast.success(
      status === "active"
        ? t("orgs.connections.enabledConnections", { count: updated })
        : t("orgs.connections.disabledConnections", { count: updated }),
    );
    exitSelectionMode();
  };

  const handleAddToAgent = async (agentId: string) => {
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return;
    track("connections_bulk_add_to_agent", {
      agent_id: agentId,
      count: selectedIds.size,
    });

    const existingConnIds = new Set(
      agent.connections.map((c) => c.connection_id),
    );
    const newConns = [...selectedIds]
      .filter((id) => !existingConnIds.has(id))
      .map((connection_id) => ({
        connection_id,
        selected_tools: null as string[] | null,
        selected_resources: null as string[] | null,
        selected_prompts: null as string[] | null,
      }));

    if (newConns.length === 0) {
      toast.info(t("orgs.connections.allConnectionsAlreadyInAgent"));
      return;
    }

    try {
      await studio.call("COLLECTION_VIRTUAL_MCP_UPDATE", {
        id: agentId,
        data: {
          connections: [...agent.connections, ...newConns],
        },
      });

      queryClient.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey;
          return (
            key[1] === org.id &&
            key[3] === "collection" &&
            key[4] === "VIRTUAL_MCP"
          );
        },
      });

      toast.success(
        t("orgs.connections.addedConnectionsToAgent", {
          count: newConns.length,
          agentTitle: agent.title,
        }),
      );
      exitSelectionMode();
    } catch {
      toast.error(t("orgs.connections.failedToAddConnectionsToAgent"));
    }
  };

  return (
    <>
      <DeleteConnectionDialogs {...deleteConnection} />

      {/* Bulk action dialogs */}
      <BulkDeleteDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        count={selectedIds.size}
        onConfirm={handleBulkDelete}
      />
      <AddToAgentDialog
        open={addToAgentOpen}
        onOpenChange={setAddToAgentOpen}
        agents={agents}
        onConfirm={handleAddToAgent}
      />

      {/* Cards */}
      {mergedDiscovery.isInitialLoading && activeTab === "all" ? (
        <div className="flex h-full items-center justify-center">
          <Loading01 size={32} className="animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div>
          {(
            isSearching
              ? catalogItems.length === 0 && filteredConnections.length === 0
              : activeTab === "all"
                ? catalogItems.length === 0
                : filteredConnections.length === 0
          ) ? (
            <EmptyState
              image={
                <img
                  src="/emptystate-mcp.svg"
                  alt=""
                  width={336}
                  height={320}
                  aria-hidden="true"
                />
              }
              title={t("orgs.connections.noConnectionsFound")}
              description={
                listState.search
                  ? t("orgs.connections.noConnectionsMatchSearch", {
                      search: listState.search,
                    })
                  : canManage
                    ? t("orgs.connections.createConnectionToGetStarted")
                    : t("orgs.connections.askAdminToAddConnection")
              }
            />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
              {groupedForDisplay.map((item) => {
                if (item.type === "group") {
                  return (
                    <ConnectionGroupCard
                      key={item.key}
                      group={item}
                      onOpen={() => {
                        navigate({
                          to: "/$org/settings/connections/$appSlug",
                          params: {
                            org: org.slug,
                            appSlug: item.key,
                          },
                        });
                      }}
                      selectionMode={selectionMode}
                      selectedIds={selectedIds}
                      onToggleSelect={toggleSelect}
                    />
                  );
                }

                const connection = item.connection;
                const isSelected = selectedIds.has(connection.id);
                return (
                  <ConnectionCard
                    key={connection.id}
                    connection={connection}
                    fallbackIcon={<Container />}
                    onClick={() =>
                      selectionMode
                        ? toggleSelect(connection.id)
                        : navigate({
                            to: "/$org/settings/connections/$appSlug",
                            params: {
                              org: org.slug,
                              appSlug: getConnectionSlug(connection),
                            },
                          })
                    }
                    className={cn(
                      isSelected && "ring-2 ring-primary bg-primary/5",
                    )}
                    headerActionsAlwaysVisible
                    headerActions={
                      <ConnectionCardHeaderActions
                        connection={connection}
                        isSelected={isSelected}
                        selectionMode={selectionMode}
                        canManage={canManage}
                        canManageAgents={canManageAgents}
                        onToggleSelect={() => toggleSelect(connection.id)}
                        onOpen={() =>
                          navigate({
                            to: "/$org/settings/connections/$appSlug",
                            params: {
                              org: org.slug,
                              appSlug: getConnectionSlug(connection),
                            },
                          })
                        }
                        onToggleStatus={(status) =>
                          handleToggleStatus(connection.id, status)
                        }
                        onDelete={() =>
                          deleteConnection.requestDelete(connection)
                        }
                      />
                    }
                  />
                );
              })}
              {/* Catalog items (uninstalled) — only on "All" tab */}
              {catalogItems.map((item) => (
                <CatalogItemCard
                  key={`catalog-${item._registryId}:${item.id}`}
                  item={item}
                  canManage={canManage}
                  allConnections={connections}
                  connectedAppNames={connectedAppNames}
                  connectingItemId={connectingItemId}
                  onNavigateConnected={(conn) =>
                    navigate({
                      to: "/$org/settings/connections/$appSlug",
                      params: {
                        org: org.slug,
                        appSlug: getConnectionSlug(conn),
                      },
                    })
                  }
                  onConnect={handleInlineConnect}
                />
              ))}
              {(activeTab === "all" || isSearching) &&
                enabledRegistries.length > 0 && (
                  <div ref={catalogSentinelRef} className="col-span-full h-4" />
                )}
              {(activeTab === "all" || isSearching) &&
                mergedDiscovery.isLoadingMore && (
                  <div className="col-span-full flex justify-center py-6">
                    <Loading01
                      size={24}
                      className="animate-spin text-muted-foreground"
                    />
                  </div>
                )}
            </div>
          )}
        </div>
      )}

      {/* Floating bulk action bar */}
      {selectionMode && (
        <BulkActionBar
          count={selectedIds.size}
          total={filteredConnections.length}
          canManage={canManage}
          canManageAgents={canManageAgents}
          onSelectAll={() => {
            setSelectedIds(new Set(filteredConnections.map((c) => c.id)));
          }}
          onDeselectAll={() => setSelectedIds(new Set())}
          onDelete={() => setBulkDeleteOpen(true)}
          onAddToAgent={() => setAddToAgentOpen(true)}
          onToggleStatus={handleBulkToggleStatus}
          onCancel={exitSelectionMode}
        />
      )}
    </>
  );
}

function OrgMcpsContent() {
  const t = useT();
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as {
    action?: "create";
    tab?: "all" | "connected";
  };
  const { data: session } = authClient.useSession();
  const { stdioEnabled } = useAuthConfig();
  const isMobile = useIsMobile();
  const { granted: canManage } = useCapability("connections:manage");

  // Consolidated list UI state (search, filters, sorting, view mode)
  const listState = useListState<ConnectionEntity>({
    namespace: org.slug,
    resource: "connections",
  });

  const actions = useConnectionActions();

  // Tab state
  type ConnectionTab = "connected" | "all";
  const [activeTab, setActiveTab] = useLocalStorage<ConnectionTab>(
    LOCALSTORAGE_KEYS.connectionsTab(org.slug),
    (existing) =>
      search.tab === "all" || search.tab === "connected"
        ? search.tab
        : (existing ?? "all"),
  );

  // Type, status & registry filters
  const [typeFilter, setTypeFilter] = useState<ConnectionTypeFilter>("ALL");
  const [statusFilter, setStatusFilter] =
    useState<ConnectionStatusFilter>("ALL");
  const [registryFilter, setRegistryFilter] = useState<string>("ALL");

  // Registry / catalog - merge all enabled registries (needed for create dialog provider hints)
  const enabledRegistries = useEnabledRegistries();
  const mergedDiscovery = useMergedStoreDiscovery(
    enabledRegistries,
    listState.searchTerm,
  );
  const registryItems = mergedDiscovery.items;

  const isStale = listState.search !== listState.searchTerm;

  // React Hook Form setup
  const form = useForm<ConnectionFormData>({
    resolver: zodResolver(connectionFormSchema),
    defaultValues: {
      title: "",
      description: null,
      icon: null,
      ui_type: "HTTP",
      connection_url: "",
      connection_token: null,
      npx_package: "",
      stdio_command: "",
      stdio_args: "",
      stdio_cwd: "",
      env_vars: [],
    },
  });

  // Watch the ui_type to conditionally render fields
  const uiType = form.watch("ui_type");
  const connectionUrl = form.watch("connection_url");
  const npxPackage = form.watch("npx_package");

  const providerHint =
    inferHardcodedProviderHint({
      uiType,
      connectionUrl: connectionUrl ?? "",
      npxPackage: npxPackage ?? "",
    }) ??
    inferRegistryProviderHint({
      uiType,
      connectionUrl: connectionUrl ?? "",
      registryItems,
    });

  // Create dialog state is derived from search params, but gated on capability
  // so it can't be opened by deep-linking to ?action=create without
  // connections:manage (the write would fail server-side regardless).
  const isCreating = canManage && search.action === "create";

  const openCreateDialog = () => {
    track("connections_custom_dialog_opened", {
      source: "connections_page",
    });
    navigate({
      to: "/$org/settings/connections",
      params: { org: org.slug },
      search: { action: "create" },
    });
  };

  const closeCreateDialog = () => {
    navigate({
      to: "/$org/settings/connections",
      params: { org: org.slug },
      search: {},
    });
  };

  const onSubmit = async (data: ConnectionFormData) => {
    // Determine actual connection_type, connection_url, and connection_headers based on ui_type
    let connectionType: "HTTP" | "SSE" | "Websocket" | "STDIO";
    let connectionUrl: string | null = null;
    let connectionToken: string | null = null;
    let connectionParameters:
      | StdioConnectionParameters
      | HttpConnectionParameters
      | null = null;

    if (data.ui_type === "NPX") {
      // NPX maps to STDIO with parameters (no URL needed)
      connectionType = "STDIO";
      connectionUrl = "";
      connectionParameters = buildNpxParameters(
        data.npx_package || "",
        data.env_vars || [],
      );
    } else if (data.ui_type === "STDIO") {
      // Custom STDIO command
      connectionType = "STDIO";
      connectionUrl = "";
      connectionParameters = buildCustomStdioParameters(
        data.stdio_command || "",
        data.stdio_args || "",
        data.stdio_cwd,
        data.env_vars || [],
      );
    } else {
      connectionType = data.ui_type;
      connectionUrl = data.connection_url || "";
      connectionToken = data.connection_token || null;
    }

    const newId = generatePrefixedId("conn");
    track("connection_custom_created", {
      connection_type: connectionType,
      ui_type: data.ui_type,
    });
    // Create new connection
    await actions.create.mutateAsync({
      id: newId,
      title: data.title,
      description: data.description || null,
      connection_type: connectionType,
      connection_url: connectionUrl,
      connection_token: connectionToken,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      created_by: session?.user?.id || "system",
      organization_id: org.id,
      icon: data.icon ?? null,
      app_name: null,
      app_id: null,
      connection_headers: connectionParameters,
      oauth_config: null,
      configuration_state: null,
      metadata: null,
      tools: null,
      bindings: null,
      status: "inactive",
    });

    closeCreateDialog();
    form.reset();
    navigate({
      to: "/$org/settings/connections/$appSlug",
      params: {
        org: org.slug,
        appSlug: getConnectionSlug({
          app_name: null,
          connection_url: connectionUrl,
          title: data.title,
          id: newId,
        }),
      },
    });
  };

  const handleDialogClose = (open: boolean) => {
    if (!open) {
      if (isCreating) {
        closeCreateDialog();
      }
      form.reset();
    }
  };

  const applyInferenceFromInput = (rawInput: string) => {
    const raw = rawInput.trim();
    if (!raw) return;

    const titleIsDirty = Boolean(form.formState.dirtyFields.title);
    const descriptionIsDirty = Boolean(form.formState.dirtyFields.description);
    const envVarsIsDirty = Boolean(form.formState.dirtyFields.env_vars);

    const applySuggestedMeta = (hint: ConnectionProviderHint | null) => {
      if (!hint) return;

      if (!titleIsDirty && !form.getValues("title").trim() && hint.title) {
        form.setValue("title", hint.title, { shouldDirty: false });
      }

      if (
        !descriptionIsDirty &&
        !(form.getValues("description") ?? "").trim() &&
        hint.description
      ) {
        form.setValue("description", hint.description, { shouldDirty: false });
      }

      if (!envVarsIsDirty && hint.envVarKeys?.length) {
        const current = form.getValues("env_vars") ?? [];
        const existingKeys = new Set(current.map((v) => v.key));
        const toAdd = hint.envVarKeys.filter((k) => !existingKeys.has(k));
        if (toAdd.length > 0) {
          form.setValue(
            "env_vars",
            [...current, ...toAdd.map((key) => ({ key, value: "" }))],
            { shouldDirty: true },
          );
        }
      }
    };

    const npx = parseNpxLikeCommand(raw);
    if (npx && stdioEnabled) {
      form.setValue("ui_type", "NPX", { shouldDirty: true });
      form.setValue("npx_package", npx.packageName, { shouldDirty: true });
      // Clear HTTP fields for clarity
      form.setValue("connection_url", "", { shouldDirty: true });
      form.setValue("connection_token", null, { shouldDirty: true });

      applySuggestedMeta(
        inferHardcodedProviderHint({
          uiType: "NPX",
          npxPackage: npx.packageName,
        }),
      );
      return;
    }

    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      const nextUiType =
        uiType === "HTTP" || uiType === "SSE" || uiType === "Websocket"
          ? uiType
          : "HTTP";
      form.setValue("ui_type", nextUiType, { shouldDirty: true });
      form.setValue("connection_url", raw, { shouldDirty: true });

      applySuggestedMeta(
        inferHardcodedProviderHint({
          uiType: nextUiType,
          connectionUrl: raw,
        }) ??
          inferRegistryProviderHint({
            uiType: nextUiType,
            connectionUrl: raw,
            registryItems,
          }),
      );
      return;
    }

    // NPX package typed directly (no "npx" prefix)
    if (uiType === "NPX") {
      applySuggestedMeta(
        inferHardcodedProviderHint({
          uiType: "NPX",
          npxPackage: raw,
        }),
      );
    }
  };

  const ctaButton = canManage ? (
    <div className="flex items-center gap-2">
      <Button variant="outline" onClick={openCreateDialog}>
        <Plus size={14} className="sm:hidden" />
        <span className="hidden sm:inline">
          {t("orgs.connections.customConnection")}
        </span>
      </Button>
    </div>
  ) : null;

  return (
    <>
      <Page>
        {(() => {
          const dialogTitle = t("orgs.connections.createConnection");
          const dialogDescription = t(
            "orgs.connections.createConnectionDescription",
          );
          const submitLabel = form.formState.isSubmitting
            ? t("orgs.connections.saving")
            : t("orgs.connections.createConnection");

          const formFields = (
            <div className="grid gap-4">
              <FormField
                control={form.control}
                name="ui_type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("orgs.connections.type")}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="HTTP">
                          <span className="flex items-center gap-2">
                            <Globe02 className="w-4 h-4" />
                            HTTP
                          </span>
                        </SelectItem>
                        <SelectItem value="SSE">
                          <span className="flex items-center gap-2">
                            <Globe02 className="w-4 h-4" />
                            SSE
                          </span>
                        </SelectItem>
                        <SelectItem value="Websocket">
                          <span className="flex items-center gap-2">
                            <Globe02 className="w-4 h-4" />
                            Websocket
                          </span>
                        </SelectItem>
                        {stdioEnabled && (
                          <>
                            <SelectItem value="NPX">
                              <span className="flex items-center gap-2">
                                <Container className="w-4 h-4" />
                                {t("orgs.connections.npxPackage")}
                              </span>
                            </SelectItem>
                            <SelectItem value="STDIO">
                              <span className="flex items-center gap-2">
                                <Terminal className="w-4 h-4" />
                                {t("orgs.connections.customCommand")}
                              </span>
                            </SelectItem>
                          </>
                        )}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* NPX-specific fields */}
              {uiType === "NPX" && (
                <FormField
                  control={form.control}
                  name="npx_package"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("orgs.connections.npmPackage")}</FormLabel>
                      <FormControl>
                        <Input
                          placeholder={t(
                            "orgs.connections.npmPackagePlaceholder",
                          )}
                          {...field}
                          value={field.value ?? ""}
                          onPaste={(e) => {
                            const pasted = e.clipboardData.getData("text");
                            if (!pasted) return;
                            e.preventDefault();
                            form.setValue("npx_package", pasted.trim(), {
                              shouldDirty: true,
                            });
                            applyInferenceFromInput(pasted);
                          }}
                          onBlur={(e) => {
                            applyInferenceFromInput(e.target.value);
                            field.onBlur();
                          }}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {/* STDIO/Custom Command fields */}
              {uiType === "STDIO" && (
                <>
                  <div className="grid grid-cols-2 gap-4 items-start">
                    <FormField
                      control={form.control}
                      name="stdio_command"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("orgs.connections.command")}</FormLabel>
                          <FormControl>
                            <Input
                              placeholder={t(
                                "orgs.connections.commandPlaceholder",
                              )}
                              {...field}
                              value={field.value ?? ""}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="stdio_args"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            {t("orgs.connections.arguments")}
                          </FormLabel>
                          <FormControl>
                            <Input
                              placeholder={t(
                                "orgs.connections.argumentsPlaceholder",
                              )}
                              {...field}
                              value={field.value ?? ""}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <FormField
                    control={form.control}
                    name="stdio_cwd"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          {t("orgs.connections.workingDirectory")}
                        </FormLabel>
                        <FormControl>
                          <Input
                            placeholder={t(
                              "orgs.connections.workingDirectoryPlaceholder",
                            )}
                            {...field}
                            value={field.value ?? ""}
                          />
                        </FormControl>
                        <p className="text-xs text-muted-foreground">
                          {t("orgs.connections.directoryExecutionNote")}
                        </p>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </>
              )}

              {/* Shared: Environment Variables for NPX and STDIO */}
              {(uiType === "NPX" || uiType === "STDIO") && (
                <FormField
                  control={form.control}
                  name="env_vars"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        {t("orgs.connections.environmentVariables")}
                      </FormLabel>
                      <FormControl>
                        <EnvVarsEditor
                          value={field.value ?? []}
                          onChange={field.onChange}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {/* HTTP/SSE/Websocket fields */}
              {uiType !== "NPX" && uiType !== "STDIO" && (
                <>
                  <FormField
                    control={form.control}
                    name="connection_url"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("orgs.connections.url")}</FormLabel>
                        <FormControl>
                          <Input
                            placeholder={t("orgs.connections.urlPlaceholder")}
                            {...field}
                            value={field.value ?? ""}
                            onPaste={(e) => {
                              const pasted = e.clipboardData.getData("text");
                              if (!pasted) return;
                              e.preventDefault();
                              form.setValue("connection_url", pasted.trim(), {
                                shouldDirty: true,
                              });
                              applyInferenceFromInput(pasted);
                            }}
                            onBlur={(e) => {
                              applyInferenceFromInput(e.target.value);
                              field.onBlur();
                            }}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="connection_token"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          {providerHint?.token?.label ??
                            t("orgs.connections.tokenOptional")}
                        </FormLabel>
                        <FormControl>
                          <Input
                            type="password"
                            placeholder={
                              providerHint?.token?.placeholder ??
                              t("orgs.connections.tokenPlaceholder")
                            }
                            {...field}
                            value={field.value ?? ""}
                          />
                        </FormControl>
                        {providerHint?.token?.helperText && (
                          <p className="text-xs text-muted-foreground">
                            {providerHint.token.helperText}
                            {providerHint.id === "github" && (
                              <>
                                {" "}
                                ·{" "}
                                <a
                                  className="text-foreground underline underline-offset-4 hover:text-foreground/80"
                                  href="https://github.com/settings/personal-access-tokens"
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {t("orgs.connections.openGitHubPatSettings")}
                                </a>
                              </>
                            )}
                          </p>
                        )}
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </>
              )}

              {/* Name/description come after connection mode/inputs so we can infer them */}
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("orgs.connections.name")}</FormLabel>
                    <FormControl>
                      <Input
                        placeholder={t("orgs.connections.namePlaceholder")}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("orgs.connections.description")}</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder={t(
                          "orgs.connections.descriptionPlaceholder",
                        )}
                        rows={3}
                        {...field}
                        value={field.value ?? ""}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          );

          const isOpen = isCreating;

          if (isMobile) {
            return (
              <Drawer open={isOpen} onOpenChange={handleDialogClose}>
                <DrawerContent className="max-h-[90vh]">
                  <DrawerHeader className="pb-2">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 text-left">
                        <DrawerTitle>{dialogTitle}</DrawerTitle>
                        <DrawerDescription className="mt-1">
                          {dialogDescription}
                        </DrawerDescription>
                      </div>
                      <DrawerClose asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="shrink-0 -mt-1"
                          aria-label={t("orgs.connections.close")}
                        >
                          <XClose size={16} />
                        </Button>
                      </DrawerClose>
                    </div>
                  </DrawerHeader>
                  <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)}>
                      <div className="overflow-y-auto px-4 pb-4">
                        {formFields}
                      </div>
                      <DrawerFooter>
                        <Button
                          type="submit"
                          disabled={form.formState.isSubmitting}
                          className="w-full"
                        >
                          {submitLabel}
                        </Button>
                      </DrawerFooter>
                    </form>
                  </Form>
                </DrawerContent>
              </Drawer>
            );
          }

          return (
            <Dialog open={isOpen} onOpenChange={handleDialogClose}>
              <DialogContent className="sm:max-w-[525px]">
                <DialogHeader>
                  <DialogTitle>{dialogTitle}</DialogTitle>
                  <DialogDescription>{dialogDescription}</DialogDescription>
                </DialogHeader>
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(onSubmit)}>
                    <div className="py-4">{formFields}</div>
                    <DialogFooter>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleDialogClose(false)}
                      >
                        {t("orgs.connections.cancel")}
                      </Button>
                      <Button
                        type="submit"
                        disabled={form.formState.isSubmitting}
                        className="min-w-40"
                      >
                        {submitLabel}
                      </Button>
                    </DialogFooter>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>
          );
        })()}

        <Page.Content>
          {/* Title + Toolbar */}
          <Page.Body>
            <div className="flex flex-col gap-6">
              <Page.Title>{t("orgs.connections.pageTitle")}</Page.Title>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <SearchInput
                    value={listState.search}
                    onChange={listState.setSearch}
                    placeholder={t("orgs.connections.searchPlaceholder")}
                    className="w-full md:w-[375px]"
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        listState.setSearch("");
                        (event.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                  <CollectionDisplayButton
                    sortKey={listState.sortKey}
                    sortDirection={listState.sortDirection}
                    onSort={listState.handleSort}
                    sortOptions={[
                      { id: "title", label: t("orgs.connections.sortName") },
                      {
                        id: "description",
                        label: t("orgs.connections.sortDescription"),
                      },
                      {
                        id: "connection_type",
                        label: t("orgs.connections.sortType"),
                      },
                      {
                        id: "updated_by",
                        label: t("orgs.connections.sortUpdatedBy"),
                      },
                      {
                        id: "updated_at",
                        label: t("orgs.connections.sortUpdated"),
                      },
                    ]}
                    filters={[
                      {
                        label: t("orgs.connections.filterType"),
                        value: typeFilter,
                        onChange: (v) =>
                          setTypeFilter((v as ConnectionTypeFilter) || "ALL"),
                        options: [
                          { id: "ALL", label: t("orgs.connections.filterAll") },
                          { id: "HTTP", label: "HTTP" },
                          { id: "SSE", label: "SSE" },
                          { id: "Websocket", label: "WebSocket" },
                          { id: "STDIO", label: "STDIO" },
                        ],
                      },
                      {
                        label: t("orgs.connections.filterStatus"),
                        value: statusFilter,
                        onChange: (v) =>
                          setStatusFilter(
                            (v as ConnectionStatusFilter) || "ALL",
                          ),
                        options: [
                          { id: "ALL", label: t("orgs.connections.filterAll") },
                          {
                            id: "active",
                            label: t("orgs.connections.filterActive"),
                          },
                          {
                            id: "inactive",
                            label: t("orgs.connections.filterInactive"),
                          },
                          {
                            id: "error",
                            label: t("orgs.connections.filterError"),
                          },
                        ],
                      },
                      ...(enabledRegistries.length > 1
                        ? [
                            {
                              label: t("orgs.connections.filterRegistry"),
                              value: registryFilter,
                              onChange: (v: string) =>
                                setRegistryFilter(v || "ALL"),
                              options: [
                                {
                                  id: "ALL",
                                  label: t(
                                    "orgs.connections.filterAllRegistries",
                                  ),
                                },
                                ...enabledRegistries.map((r) => ({
                                  id: r.id,
                                  label: r.id.includes("community-registry")
                                    ? t("orgs.connections.communityMcpRegistry")
                                    : r.title,
                                })),
                              ],
                            },
                          ]
                        : []),
                    ]}
                  />
                </div>
                {ctaButton}
              </div>
              <CollectionTabs
                tabs={[
                  { id: "all", label: t("orgs.connections.tabAll") },
                  {
                    id: "connected",
                    label: t("orgs.connections.tabConnected"),
                  },
                ]}
                activeTab={activeTab}
                onTabChange={(id) => {
                  const next = id as ConnectionTab;
                  if (next !== activeTab) {
                    track("connections_page_tab_changed", { to_tab: next });
                  }
                  setActiveTab(next);
                }}
              />
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center">
                    <Loading01
                      size={32}
                      className="animate-spin text-muted-foreground"
                    />
                  </div>
                }
              >
                <div
                  style={{
                    opacity: isStale ? 0.5 : 1,
                    transition: isStale
                      ? "opacity 0.2s 0.2s linear"
                      : "opacity 0s 0s linear",
                    pointerEvents: isStale ? "none" : "auto",
                  }}
                >
                  <ConnectionResults
                    listState={listState}
                    activeTab={activeTab}
                    typeFilter={typeFilter}
                    statusFilter={statusFilter}
                    registryFilter={registryFilter}
                    enabledRegistries={enabledRegistries}
                  />
                </div>
              </Suspense>
            </div>
          </Page.Body>
        </Page.Content>
      </Page>
    </>
  );
}

export default function OrgMcps() {
  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Loading01
              size={32}
              className="animate-spin text-muted-foreground"
            />
          </div>
        }
      >
        <OrgMcpsContent />
      </Suspense>
    </ErrorBoundary>
  );
}
