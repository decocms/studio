import { EmptyState } from "@/web/components/empty-state.tsx";
import { ErrorBoundary } from "@/web/components/error-boundary";
import {
  envVarsToRecord,
  recordToEnvVars,
  type EnvVar,
} from "@/web/components/env-vars-editor";
import { getUIResourceUri } from "@/mcp-apps/types.ts";
import { SaveActions } from "@/web/components/save-actions";
import {
  useBindingConnections,
  useCollectionBindings,
} from "@/web/hooks/use-binding";
import { useMCPAuthStatus } from "@/web/hooks/use-mcp-auth-status";
import { authenticateMcp } from "@/web/lib/mcp-oauth";
import { KEYS } from "@/web/lib/query-keys";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@deco/ui/components/breadcrumb.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { CollectionTabs } from "@/web/components/collections/collection-tabs.tsx";
import {
  isStdioParameters,
  ORG_ADMIN_PROJECT_SLUG,
  useConnection,
  useConnectionActions,
  useMCPClient,
  useMCPPromptsListQuery,
  useMCPResourcesListQuery,
  useMCPToolsListQuery,
  useProjectContext,
  type ConnectionEntity,
  type HttpConnectionParameters,
  type StdioConnectionParameters,
  type ToolDefinition,
} from "@decocms/mesh-sdk";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { Loading01 } from "@untitledui/icons";
import { Suspense } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { ViewActions, ViewLayout } from "../layout";
import { CollectionTab } from "./collection-tab";
import { ConnectionSidebar } from "./connection-sidebar";
import { PromptsTab } from "./prompts-tab";
import { ReadmeTab } from "./readme-tab";
import { ResourcesTab } from "./resources-tab";
import { SettingsTab } from "./settings-tab";
import {
  connectionFormSchema,
  type ConnectionFormData,
} from "./settings-tab/schema";
import { ToolsTab } from "./tools-tab";
import { UiTab } from "./ui-tab";

/**
 * Check if STDIO params look like an NPX command
 */
function isNpxCommand(params: StdioConnectionParameters): boolean {
  return params.command === "npx";
}

/**
 * Parse STDIO connection_headers back to NPX form fields
 */
function parseStdioToNpx(params: StdioConnectionParameters): string {
  return params.args?.find((a) => !a.startsWith("-")) ?? "";
}

/**
 * Parse STDIO connection_headers to custom command form fields
 */
function parseStdioToCustom(params: StdioConnectionParameters): {
  command: string;
  args: string;
  cwd: string;
} {
  return {
    command: params.command,
    args: params.args?.join(" ") ?? "",
    cwd: params.cwd ?? "",
  };
}

/**
 * Build STDIO connection_headers from NPX form fields
 */
function buildNpxParameters(
  packageName: string,
  envVars: EnvVar[],
): StdioConnectionParameters {
  const params: StdioConnectionParameters = {
    command: "npx",
    args: ["-y", packageName],
  };
  const envRecord = envVarsToRecord(envVars);
  if (Object.keys(envRecord).length > 0) {
    params.envVars = envRecord;
  }
  return params;
}

/**
 * Build STDIO connection_headers from custom command form fields
 */
function buildCustomStdioParameters(
  command: string,
  argsString: string,
  cwd: string | undefined,
  envVars: EnvVar[],
): StdioConnectionParameters {
  const params: StdioConnectionParameters = {
    command: command,
  };

  if (argsString.trim()) {
    params.args = argsString.trim().split(/\s+/);
  }

  if (cwd?.trim()) {
    params.cwd = cwd.trim();
  }

  const envRecord = envVarsToRecord(envVars);
  if (Object.keys(envRecord).length > 0) {
    params.envVars = envRecord;
  }

  return params;
}

/**
 * Convert connection entity to form values
 */
function connectionToFormValues(
  connection: ConnectionEntity,
  scopes?: string[],
): ConnectionFormData {
  const baseFields = {
    title: connection.title,
    description: connection.description ?? "",
    configuration_state: connection.configuration_state ?? {},
    configuration_scopes: scopes || connection.configuration_scopes || [],
  };

  if (
    connection.connection_type === "STDIO" &&
    isStdioParameters(connection.connection_headers)
  ) {
    const stdioParams = connection.connection_headers;
    const envVars = recordToEnvVars(stdioParams.envVars);

    if (isNpxCommand(stdioParams)) {
      const npxPackage = parseStdioToNpx(stdioParams);
      return {
        ...baseFields,
        ui_type: "NPX",
        connection_url: "",
        connection_token: null,
        npx_package: npxPackage,
        stdio_command: "",
        stdio_args: "",
        stdio_cwd: "",
        env_vars: envVars,
      };
    }

    const customData = parseStdioToCustom(stdioParams);
    return {
      ...baseFields,
      ui_type: "STDIO",
      connection_url: "",
      connection_token: null,
      npx_package: "",
      stdio_command: customData.command,
      stdio_args: customData.args,
      stdio_cwd: customData.cwd,
      env_vars: envVars,
    };
  }

  return {
    ...baseFields,
    ui_type: connection.connection_type as "HTTP" | "SSE" | "Websocket",
    connection_url: connection.connection_url ?? "",
    connection_token: null,
    npx_package: "",
    stdio_command: "",
    stdio_args: "",
    stdio_cwd: "",
    env_vars: [],
  };
}

/**
 * Convert form values back to connection entity update
 */
function formValuesToConnectionUpdate(
  data: ConnectionFormData,
): Partial<ConnectionEntity> {
  let connectionType: "HTTP" | "SSE" | "Websocket" | "STDIO";
  let connectionUrl: string | null = null;
  let connectionToken: string | null = null;
  let connectionParameters:
    | StdioConnectionParameters
    | HttpConnectionParameters
    | null = null;

  if (data.ui_type === "NPX") {
    connectionType = "STDIO";
    connectionUrl = "";
    connectionParameters = buildNpxParameters(
      data.npx_package || "",
      data.env_vars || [],
    );
  } else if (data.ui_type === "STDIO") {
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

  return {
    title: data.title,
    description: data.description || null,
    connection_type: connectionType,
    connection_url: connectionUrl,
    ...(connectionToken && { connection_token: connectionToken }),
    ...(connectionParameters && { connection_headers: connectionParameters }),
    configuration_state: data.configuration_state ?? null,
    configuration_scopes: data.configuration_scopes ?? null,
  };
}

function ConnectionInspectorViewWithConnection({
  connection,
  connectionId,
  org,
  requestedTabId,
  collections,
  onUpdate,
  isUpdating,
  prompts,
  resources,
  tools,
  isLoadingTools,
}: {
  connection: ConnectionEntity;
  connectionId: string;
  org: string;
  requestedTabId: string;
  collections: ReturnType<typeof useCollectionBindings>;
  onUpdate: (connection: Partial<ConnectionEntity>) => Promise<void>;
  isUpdating: boolean;
  prompts: Array<{ name: string; description?: string }>;
  resources: Array<{
    uri: string;
    name?: string;
    description?: string;
    mimeType?: string;
  }>;
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    annotations?: ToolDefinition["annotations"];
    _meta?: Record<string, unknown>;
  }>;
  isLoadingTools: boolean;
}) {
  const navigate = useNavigate({ from: "/$org/$project/mcps/$connectionId" });
  const queryClient = useQueryClient();
  const connectionActions = useConnectionActions();

  const authStatus = useMCPAuthStatus({
    connectionId: connectionId,
  });
  // VIRTUAL connections are always "authenticated" - they don't have OAuth
  // They're internal connections that aggregate tools from other connections
  const isVirtualConnection = connection?.connection_type === "VIRTUAL";
  const isMCPAuthenticated = isVirtualConnection || authStatus.isAuthenticated;

  // Check if connection has MCP binding for configuration
  const mcpBindingConnections = useBindingConnections({
    connections: [connection],
    binding: "MCP",
  });
  const hasMcpBinding = mcpBindingConnections.length > 0;

  // Check if connection has repository info for README tab (stored in metadata)
  const repository = connection?.metadata?.repository as
    | { url?: string; source?: string; subfolder?: string }
    | undefined;
  const hasRepository = !!repository?.url;

  // Form state lifted to parent
  const form = useForm<ConnectionFormData>({
    resolver: zodResolver(connectionFormSchema),
    values: connectionToFormValues(connection),
  });

  const hasAnyChanges = form.formState.isDirty;

  const handleSave = async () => {
    const isValid = await form.trigger();
    if (!isValid) return;

    const data = form.getValues();
    const updateData = formValuesToConnectionUpdate(data);
    await onUpdate(updateData);
    form.reset(data);
  };

  const handleUndo = () => {
    form.reset(connectionToFormValues(connection));
  };

  const handleAuthenticate = async () => {
    const { token, tokenInfo, error } = await authenticateMcp({
      connectionId: connection.id,
    });
    if (error || !token) {
      toast.error(`Authentication failed: ${error}`);
      return;
    }

    if (tokenInfo) {
      try {
        const response = await fetch(
          `/api/connections/${connection.id}/oauth-token`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              accessToken: tokenInfo.accessToken,
              refreshToken: tokenInfo.refreshToken,
              expiresIn: tokenInfo.expiresIn,
              scope: tokenInfo.scope,
              clientId: tokenInfo.clientId,
              clientSecret: tokenInfo.clientSecret,
              tokenEndpoint: tokenInfo.tokenEndpoint,
            }),
          },
        );
        if (!response.ok) {
          console.error("Failed to save OAuth token:", await response.text());
          await connectionActions.update.mutateAsync({
            id: connection.id,
            data: { connection_token: token },
          });
        } else {
          try {
            await connectionActions.update.mutateAsync({
              id: connection.id,
              data: {},
            });
          } catch (err) {
            console.warn(
              "Failed to refresh connection tools after OAuth:",
              err,
            );
          }
        }
      } catch (err) {
        console.error("Error saving OAuth token:", err);
        await connectionActions.update.mutateAsync({
          id: connection.id,
          data: { connection_token: token },
        });
      }
    } else {
      await connectionActions.update.mutateAsync({
        id: connection.id,
        data: { connection_token: token },
      });
    }

    const mcpProxyUrl = new URL(
      `/mcp/${connection.id}`,
      window.location.origin,
    );
    await queryClient.invalidateQueries({
      queryKey: KEYS.isMCPAuthenticated(mcpProxyUrl.href, null),
    });

    toast.success("Authentication successful");
  };

  const handleRemoveOAuth = async () => {
    try {
      const response = await fetch(
        `/api/connections/${connection.id}/oauth-token`,
        {
          method: "DELETE",
          credentials: "include",
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        toast.error(`Failed to remove OAuth: ${errorText}`);
        return;
      }

      const mcpProxyUrl = new URL(
        `/mcp/${connection.id}`,
        window.location.origin,
      );
      await queryClient.invalidateQueries({
        queryKey: KEYS.isMCPAuthenticated(mcpProxyUrl.href, null),
      });

      toast.success(
        "OAuth removed. You can now re-authenticate with a different account.",
      );
    } catch (err) {
      console.error("Error removing OAuth token:", err);
      toast.error("Failed to remove OAuth");
    }
  };

  const toolsCount = tools.length;
  const promptsCount = prompts.length;
  const resourcesCount = resources.length;
  const uiToolsCount = tools.filter((t) => !!getUIResourceUri(t._meta)).length;

  // Show Tools tab if we have tools OR if we're still loading them
  // This handles VIRTUAL connections and others that fetch tools dynamically
  const showToolsTab = toolsCount > 0 || isLoadingTools;

  const tabs = [
    { id: "settings", label: "Settings" },
    ...(isMCPAuthenticated && showToolsTab
      ? [
          {
            id: "tools",
            label: "Tools",
            count: isLoadingTools ? undefined : toolsCount,
          },
        ]
      : []),
    ...(isMCPAuthenticated && promptsCount > 0
      ? [{ id: "prompts", label: "Prompts", count: promptsCount }]
      : []),
    ...(isMCPAuthenticated && resourcesCount > 0
      ? [{ id: "resources", label: "Resources", count: resourcesCount }]
      : []),
    ...(isMCPAuthenticated && uiToolsCount > 0
      ? [{ id: "ui", label: "UI", count: uiToolsCount }]
      : []),
    ...(isMCPAuthenticated
      ? (collections || []).map((c) => ({ id: c.name, label: c.displayName }))
      : []),
    ...(hasRepository ? [{ id: "readme", label: "README" }] : []),
  ];

  // Default to "tools" when authenticated (if tools tab exists), otherwise "settings"
  const defaultTab =
    isMCPAuthenticated && tabs.some((t) => t.id === "tools")
      ? "tools"
      : "settings";

  const activeTabId = tabs.some((t) => t.id === requestedTabId)
    ? requestedTabId
    : defaultTab;

  const handleTabChange = (tabId: string) => {
    navigate({
      search: (prev: { tab?: string }) => ({ ...prev, tab: tabId }),
      replace: true,
    });
  };

  const activeCollection = (collections || []).find(
    (c) => c.name === activeTabId,
  );

  const breadcrumb = (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link
              to="/$org/$project/mcps"
              params={{ org, project: ORG_ADMIN_PROJECT_SLUG }}
            >
              Connections
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>{connection.title}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );

  return (
    <ViewLayout breadcrumb={breadcrumb}>
      <ViewActions>
        <SaveActions
          onSave={handleSave}
          onUndo={handleUndo}
          isDirty={hasAnyChanges}
          isSaving={isUpdating}
        />
      </ViewActions>
      <div className="flex h-full w-full bg-background overflow-hidden">
        {/* Fixed left sidebar */}
        <div className="w-100 shrink-0 border-r border-border bg-background">
          <ConnectionSidebar
            form={form}
            connection={connection}
            isMCPAuthenticated={isMCPAuthenticated}
            hasOAuthToken={authStatus.hasOAuthToken}
            onReauthenticate={handleAuthenticate}
            onRemoveOAuth={handleRemoveOAuth}
          />
        </div>

        {/* Right side - Tabs + Content */}
        <div className="flex-1 flex flex-col min-w-0 bg-background overflow-hidden">
          {/* Tabs header */}
          <div className="shrink-0 flex items-center gap-4 px-5 py-3 border-b border-border">
            <CollectionTabs
              tabs={tabs}
              activeTab={activeTabId}
              onTabChange={handleTabChange}
              className="flex-1"
            />
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-auto">
            <ErrorBoundary key={activeTabId}>
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
                {activeTabId === "tools" ? (
                  <ToolsTab
                    tools={tools}
                    connectionId={connectionId}
                    org={org}
                    isLoading={isLoadingTools}
                  />
                ) : activeTabId === "ui" ? (
                  <UiTab tools={tools} connectionId={connectionId} org={org} />
                ) : activeTabId === "prompts" ? (
                  <PromptsTab
                    prompts={prompts}
                    connectionId={connectionId}
                    org={org}
                  />
                ) : activeTabId === "resources" ? (
                  <ResourcesTab
                    resources={resources}
                    connectionId={connectionId}
                    org={org}
                  />
                ) : activeTabId === "settings" ? (
                  <SettingsTab
                    connection={connection}
                    form={form}
                    hasMcpBinding={hasMcpBinding}
                    isMCPAuthenticated={isMCPAuthenticated}
                    supportsOAuth={authStatus.supportsOAuth}
                    isServerError={authStatus.isServerError}
                    onAuthenticate={handleAuthenticate}
                    onViewReadme={
                      hasRepository
                        ? () => handleTabChange("readme")
                        : undefined
                    }
                  />
                ) : activeTabId === "readme" && hasRepository ? (
                  <ReadmeTab repository={repository} />
                ) : activeCollection && isMCPAuthenticated ? (
                  <CollectionTab
                    key={activeTabId}
                    connectionId={connectionId}
                    org={org}
                    activeCollection={activeCollection}
                  />
                ) : (
                  <EmptyState
                    title="Collection not found"
                    description="This collection may have been deleted or you may not have access."
                  />
                )}
              </Suspense>
            </ErrorBoundary>
          </div>
        </div>
      </div>
    </ViewLayout>
  );
}

function ConnectionInspectorViewContent() {
  const navigate = useNavigate({ from: "/$org/$project/mcps/$connectionId" });
  const { connectionId, org } = useParams({
    from: "/shell/$org/$project/mcps/$connectionId",
  });
  const { org: projectOrg } = useProjectContext();

  // We can use search params for active tab if we want persistent tabs
  const search = useSearch({ from: "/shell/$org/$project/mcps/$connectionId" });
  const requestedTabId = search.tab ?? "";

  const connection = useConnection(connectionId);
  const actions = useConnectionActions();

  // Detect collection bindings
  const collections = useCollectionBindings(connection ?? undefined);

  // Get MCP client for this connection (suspense-based)
  const client = useMCPClient({
    connectionId,
    orgId: projectOrg.id,
  });

  // Fetch prompts and resources using SDK hooks
  const { data: promptsData } = useMCPPromptsListQuery({ client });
  const { data: resourcesData } = useMCPResourcesListQuery({ client });

  // Fetch tools - uses cached if available, otherwise fetches dynamically
  // VIRTUAL connections always fetch dynamically because:
  // 1. Their tools column contains virtual tool definitions (code), not cached downstream tools
  // 2. The actual tools list (virtual + downstream) comes from the MCP proxy
  const isVirtualConnection = connection?.connection_type === "VIRTUAL";
  const hasCachedTools =
    !isVirtualConnection && connection?.tools && connection.tools.length > 0;
  const { data: toolsData, isLoading: isLoadingTools } = useMCPToolsListQuery({
    client,
    enabled: !hasCachedTools,
  });

  const prompts = (promptsData?.prompts ?? []).map((p) => ({
    name: p.name,
    description: p.description,
  }));
  const resources = (resourcesData?.resources ?? []).map((r) => ({
    uri: r.uri,
    name: r.name,
    description: r.description,
  }));
  const tools = hasCachedTools
    ? (connection.tools ?? [])
    : (toolsData?.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown> | undefined,
        annotations: t.annotations,
        _meta: t._meta as Record<string, unknown> | undefined,
      }));

  // Update connection handler
  const handleUpdateConnection = async (
    updatedConnection: Partial<ConnectionEntity>,
  ) => {
    await actions.update.mutateAsync({
      id: connectionId,
      data: updatedConnection,
    });
  };

  if (!connection) {
    return (
      <div className="flex h-full w-full bg-background">
        <EmptyState
          title="Connection not found"
          description="This connection may have been deleted or you may not have access."
          actions={
            <Button
              variant="outline"
              onClick={() =>
                navigate({
                  to: "/$org/$project/mcps",
                  params: {
                    org: org as string,
                    project: ORG_ADMIN_PROJECT_SLUG,
                  },
                })
              }
            >
              Back to connections
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <ConnectionInspectorViewWithConnection
      org={org}
      connection={connection}
      connectionId={connectionId}
      requestedTabId={requestedTabId}
      collections={collections}
      onUpdate={handleUpdateConnection}
      isUpdating={actions.update.isPending}
      prompts={prompts}
      resources={resources}
      tools={tools}
      isLoadingTools={isLoadingTools}
    />
  );
}

export default function ConnectionInspectorView() {
  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center bg-background">
            <Loading01
              size={32}
              className="animate-spin text-muted-foreground"
            />
          </div>
        }
      >
        <ConnectionInspectorViewContent />
      </Suspense>
    </ErrorBoundary>
  );
}
