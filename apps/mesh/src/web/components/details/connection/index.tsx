import { generatePrefixedId } from "@/shared/utils/generate-id";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { ErrorBoundary } from "@/web/components/error-boundary";
import {
  envVarsToRecord,
  recordToEnvVars,
  type EnvVar,
} from "@/web/components/env-vars-editor";
import { useBindingConnections } from "@/web/hooks/use-binding";
import { useMCPAuthStatus } from "@/web/hooks/use-mcp-auth-status";
import { useMembers } from "@/web/hooks/use-members";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import {
  authenticateMcp,
  isConnectionAuthenticated,
} from "@/web/lib/mcp-oauth";
import { KEYS } from "@/web/lib/query-keys";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@deco/ui/components/breadcrumb.tsx";
import { ConnectionInstancesPanel } from "./connection-instances-panel.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@deco/ui/components/sheet.tsx";
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
  isStdioParameters,
  useConnectionActions,
  useConnections,
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
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Loading01, Trash01 } from "@untitledui/icons";
import { Suspense, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { getConnectionSlug } from "@/web/utils/connection-slug";
import { ViewLayout } from "../layout";
import { ConnectionActivity } from "./connection-activity.tsx";
import { ConnectionAgentsPanel } from "./connection-agents-panel.tsx";
import { ConnectionCapabilities } from "./connection-capabilities.tsx";
import { ConnectionDetailHeader } from "./connection-detail-header.tsx";
import { ConnectionFields } from "./connection-sidebar.tsx";
import { SettingsTab } from "./settings-tab";
import {
  connectionFormSchema,
  type ConnectionFormData,
} from "./settings-tab/schema";

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
    icon: connection.icon ?? null,
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
    icon: data.icon ?? null,
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
  isUpdating,
  tools,
  prompts,
  resources,
  siblings,
}: {
  connection: ConnectionEntity;
  connectionId: string;
  org: string;
  isUpdating: boolean;
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    annotations?: ToolDefinition["annotations"];
    _meta?: Record<string, unknown>;
  }>;
  prompts: Array<{ name: string; description?: string }>;
  resources: Array<{ name: string; description?: string; uri?: string }>;
  siblings: ConnectionEntity[];
}) {
  const navigate = useNavigate({ from: "/$org/mcps/$appSlug" });
  const queryClient = useQueryClient();
  const connectionActions = useConnectionActions();
  const [configureInstance, setConfigureInstance] =
    useState<ConnectionEntity | null>(null);
  const [disconnectInstance, setDisconnectInstance] =
    useState<ConnectionEntity | null>(null);
  const [isAddingInstance, setIsAddingInstance] = useState(false);

  const authStatus = useMCPAuthStatus({
    connectionId: connectionId,
  });

  const { data: membersData } = useMembers();
  const members = membersData?.data?.members ?? [];
  const activeInstance = configureInstance ?? connection;
  const instanceCreator = members.find(
    (m) => m.userId === activeInstance.created_by,
  );
  // VIRTUAL connections are always "authenticated" - they don't have OAuth
  // They're internal connections that aggregate tools from other connections
  const isVirtualConnection = connection?.connection_type === "VIRTUAL";
  const isMCPAuthenticated = isVirtualConnection || authStatus.isAuthenticated;

  // Check if connection has MCP binding for configuration.
  // Use live tools from the MCP proxy (passed as prop) instead of connection.tools,
  // because the LIST endpoint no longer fetches tools by default (include_tools=false).
  const connectionWithLiveTools = { ...connection, tools } as ConnectionEntity;
  const mcpBindingConnections = useBindingConnections({
    connections: [connectionWithLiveTools],
    binding: "MCP",
  });
  const hasMcpBinding = mcpBindingConnections.length > 0;

  // Form state lifted to parent
  const form = useForm<ConnectionFormData>({
    resolver: zodResolver(connectionFormSchema),
    values: connectionToFormValues(configureInstance ?? connection),
  });

  const hasAnyChanges = form.formState.isDirty;

  const handleSave = async () => {
    const isValid = await form.trigger();
    if (!isValid) return;

    const data = form.getValues();
    const updateData = formValuesToConnectionUpdate(data);
    const idToUpdate = configureInstance?.id ?? connectionId;
    await connectionActions.update.mutateAsync({
      id: idToUpdate,
      data: updateData,
    });
    form.reset(data);
  };

  const handleUndo = () => {
    form.reset(connectionToFormValues(configureInstance ?? connection));
  };

  const handleAuthenticateForId = async (connId: string) => {
    const { token, tokenInfo, error } = await authenticateMcp({
      connectionId: connId,
    });
    if (error || !token) {
      toast.error(`Authentication failed: ${error}`);
      return;
    }

    if (tokenInfo) {
      try {
        const response = await fetch(`/api/connections/${connId}/oauth-token`, {
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
        });
        if (!response.ok) {
          console.error("Failed to save OAuth token:", await response.text());
          await connectionActions.update.mutateAsync({
            id: connId,
            data: { connection_token: token },
          });
        } else {
          try {
            await connectionActions.update.mutateAsync({
              id: connId,
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
          id: connId,
          data: { connection_token: token },
        });
      }
    } else {
      await connectionActions.update.mutateAsync({
        id: connId,
        data: { connection_token: token },
      });
    }

    const mcpProxyUrl = new URL(`/mcp/${connId}`, window.location.origin);
    await queryClient.invalidateQueries({
      queryKey: KEYS.isMCPAuthenticated(mcpProxyUrl.href, null),
    });

    toast.success("Authentication successful");
  };

  const handleAuthenticate = () => handleAuthenticateForId(connection.id);

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

  const handleDisconnect = async (instance: ConnectionEntity) => {
    await connectionActions.delete.mutateAsync(instance.id);
    // If we deleted the last sibling, go back to list
    if (siblings.length <= 1) {
      navigate({
        to: "/$org/mcps",
        params: { org },
      });
    }
    // Otherwise stay on same slug — remaining siblings still share it
    setDisconnectInstance(null);
  };

  const breadcrumb = (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link to="/$org/mcps" params={{ org }}>
              Connections
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>
            {(() => {
              const first = siblings[0] ?? connection;
              return first.app_name
                ? first.title.replace(/\s*\(\d+\)\s*$/, "")
                : first.title;
            })()}
          </BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );

  return (
    <>
      {/* Disconnect Confirmation */}
      <AlertDialog
        open={disconnectInstance !== null}
        onOpenChange={(open) => {
          if (!open) setDisconnectInstance(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect instance?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove{" "}
              <span className="font-medium text-foreground">
                {disconnectInstance?.title}
              </span>
              . This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                disconnectInstance && handleDisconnect(disconnectInstance)
              }
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Settings Sheet */}
      <Sheet
        open={configureInstance !== null}
        onOpenChange={(open) => {
          if (!open) setConfigureInstance(null);
        }}
      >
        <SheetContent
          side="right"
          className="sm:max-w-[520px] p-0 flex flex-col gap-0 overflow-hidden"
        >
          <SheetHeader className="px-4 py-3 md:px-6 md:py-4 border-b border-border shrink-0">
            <SheetTitle className="text-base">
              {configureInstance?.title ?? connection.title}
            </SheetTitle>
            <SheetDescription className="text-xs">
              Update URL, authentication, and other settings
            </SheetDescription>
            {instanceCreator && (
              <div className="flex items-center gap-1.5 pt-1">
                <span className="text-xs text-muted-foreground">
                  Connected by
                </span>
                <Avatar
                  url={instanceCreator.user?.image ?? undefined}
                  fallback={
                    instanceCreator.user?.name ??
                    instanceCreator.user?.email ??
                    "?"
                  }
                  size="3xs"
                  shape="circle"
                />
                <span className="text-xs font-medium text-foreground">
                  {instanceCreator.user?.name || instanceCreator.user?.email}
                </span>
              </div>
            )}
          </SheetHeader>
          <Form key={configureInstance?.id ?? connection.id} {...form}>
            <div className="flex-1 overflow-y-auto px-4 py-3 md:px-6 md:py-5 flex flex-col gap-4 md:gap-6">
              <div className="flex flex-col gap-3 md:gap-4">
                <FormField
                  control={form.control}
                  name="title"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input {...field} />
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
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value || ""} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <ConnectionFields
                form={form}
                connection={configureInstance ?? connection}
                hasOAuthToken={authStatus.hasOAuthToken}
                onReauthenticate={handleAuthenticate}
                onRemoveOAuth={handleRemoveOAuth}
              />
              <SettingsTab
                connection={configureInstance ?? connection}
                form={form}
                hasMcpBinding={hasMcpBinding}
                isMCPAuthenticated={isMCPAuthenticated}
                supportsOAuth={authStatus.supportsOAuth}
                isServerError={authStatus.isServerError}
                onAuthenticate={handleAuthenticate}
                onViewReadme={undefined}
              />
            </div>
            <div className="px-6 py-4 border-t border-border flex gap-2 shrink-0">
              <Button
                onClick={handleSave}
                disabled={!hasAnyChanges || isUpdating}
                className="flex-1"
              >
                {isUpdating ? "Saving…" : "Save changes"}
              </Button>
              {hasAnyChanges && (
                <Button variant="outline" onClick={handleUndo}>
                  Undo
                </Button>
              )}
              <Button
                variant="outline"
                className="gap-2 text-muted-foreground hover:text-destructive hover:border-destructive"
                onClick={() => {
                  const inst = configureInstance ?? connection;
                  setConfigureInstance(null);
                  setDisconnectInstance(inst);
                }}
              >
                <Trash01 size={15} />
                Delete
              </Button>
            </div>
          </Form>
        </SheetContent>
      </Sheet>

      {/* Main page */}
      <ViewLayout breadcrumb={breadcrumb}>
        <div className="flex flex-col h-full overflow-hidden">
          <ConnectionDetailHeader
            connection={connection}
            displayTitle={(() => {
              const first = siblings[0] ?? connection;
              return first.app_name
                ? first.title.replace(/\s*\(\d+\)\s*$/, "")
                : first.title;
            })()}
          />
          <div className="flex-1 overflow-auto @container">
            <div className="grid grid-cols-1 @3xl:grid-cols-2 gap-5 p-6">
              {/* Activity - col 1 */}
              <ConnectionActivity connectionId={connectionId} />
              {/* Instances + Agents - col 2 */}
              <div className="flex flex-col gap-5">
                <ConnectionInstancesPanel
                  instances={siblings}
                  onConfigure={(inst) => setConfigureInstance(inst)}
                  onAuthenticate={(inst) => handleAuthenticateForId(inst.id)}
                  onDelete={(inst) => setDisconnectInstance(inst)}
                  isAdding={isAddingInstance}
                  onAdd={async () => {
                    setIsAddingInstance(true);
                    try {
                      const base = siblings[0] ?? connection;
                      const baseName = base.title.replace(/\s*\(\d+\)\s*$/, "");
                      const nextNumber = siblings.length + 1;
                      const newTitle = `${baseName} (${nextNumber})`;
                      const newId = generatePrefixedId("conn");
                      await connectionActions.create.mutateAsync({
                        id: newId,
                        title: newTitle,
                        description: base.description ?? null,
                        connection_type: base.connection_type,
                        connection_url: base.connection_url ?? null,
                        connection_token: null,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                        created_by: base.created_by,
                        organization_id: base.organization_id,
                        icon: base.icon ?? null,
                        app_name: base.app_name ?? null,
                        app_id: base.app_id ?? null,
                        connection_headers: base.connection_headers ?? null,
                        oauth_config: null,
                        configuration_state: base.configuration_state ?? null,
                        metadata: null,
                        tools: null,
                        bindings: null,
                        status: "inactive",
                      });
                      const mcpProxyUrl = new URL(
                        `/mcp/${newId}`,
                        window.location.origin,
                      );
                      const authStatus = await isConnectionAuthenticated({
                        url: mcpProxyUrl.href,
                        token: null,
                      });
                      if (
                        authStatus.supportsOAuth &&
                        !authStatus.isAuthenticated
                      ) {
                        await handleAuthenticateForId(newId);
                      }
                      // New instance shares the same app slug — no navigation needed
                      // The page will re-render with the new sibling
                    } finally {
                      setIsAddingInstance(false);
                    }
                  }}
                />
                <ConnectionAgentsPanel connection={connection} />
              </div>
              {/* Capabilities - full width */}
              <div className="@3xl:col-span-2">
                <ConnectionCapabilities
                  tools={tools}
                  prompts={prompts}
                  resources={resources}
                  connectionId={connectionId}
                  org={org}
                />
              </div>
            </div>
          </div>
        </div>
      </ViewLayout>
    </>
  );
}

function ConnectionInspectorViewContent() {
  const navigate = useNavigate({ from: "/$org/mcps/$appSlug" });
  const { appSlug, org } = useParams({
    from: "/shell/$org/mcps/$appSlug",
  });
  const { org: projectOrg } = useProjectContext();

  const allConnections = useConnections();
  const actions = useConnectionActions();

  // Resolve appSlug → matching connections
  const siblings = allConnections.filter(
    (c) => c.connection_type !== "VIRTUAL" && getConnectionSlug(c) === appSlug,
  );
  const connection = siblings[0] ?? null;
  const connectionId = connection?.id ?? "";

  // Get MCP client for this connection (suspense-based)
  const client = useMCPClient({
    connectionId: connectionId || null,
    orgId: projectOrg.id,
  });

  // Fetch tools - uses cached if available, otherwise fetches dynamically
  // VIRTUAL connections always fetch dynamically because:
  // 1. Their tools column contains virtual tool definitions (code), not cached downstream tools
  // 2. The actual tools list (virtual + downstream) comes from the MCP proxy
  // Always fetch tools live from the MCP proxy — cached tools from
  // the connection list are used as placeholder while the live query loads.
  // This ensures newly added downstream tools appear after a page refresh.
  const { data: toolsData } = useMCPToolsListQuery({
    client,
  });

  const tools = toolsData
    ? toolsData.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown> | undefined,
        outputSchema: (t as any).outputSchema as
          | Record<string, unknown>
          | undefined,
        annotations: t.annotations,
        _meta: t._meta as Record<string, unknown> | undefined,
      }))
    : (connection?.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown> | undefined,
        outputSchema: (t as any).outputSchema as
          | Record<string, unknown>
          | undefined,
        annotations: (t as any).annotations,
        _meta: t._meta as Record<string, unknown> | undefined,
      }));

  // Aggregate tools from all siblings (deduped by name)
  const aggregatedTools = (() => {
    if (siblings.length <= 1) return tools;
    const seen = new Set<string>();
    const result: typeof tools = [];

    const toToolList = (
      source:
        | typeof tools
        | NonNullable<(typeof siblings)[number]["tools"]>
        | null
        | undefined,
    ) =>
      (source ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
        outputSchema: tool.outputSchema as Record<string, unknown> | undefined,
        annotations: tool.annotations,
        _meta: tool._meta as Record<string, unknown> | undefined,
      }));

    for (const sibling of siblings) {
      const siblingTools =
        sibling.id === connectionId ? tools : toToolList(sibling.tools);

      for (const tool of siblingTools) {
        if (!seen.has(tool.name)) {
          seen.add(tool.name);
          result.push(tool);
        }
      }
    }
    return result.length > 0 ? result : tools;
  })();

  // Fetch prompts and resources from the MCP connection
  const { data: promptsData } = useMCPPromptsListQuery({ client });
  const { data: resourcesData } = useMCPResourcesListQuery({ client });

  const prompts = (promptsData?.prompts ?? []).map((p) => ({
    name: p.name,
    description: p.description,
  }));

  const resources = (resourcesData?.resources ?? []).map((r) => ({
    name: r.name,
    description: r.description,
    uri: r.uri,
  }));

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
                  to: "/$org/mcps",
                  params: {
                    org: org as string,
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
      isUpdating={actions.update.isPending}
      tools={aggregatedTools}
      prompts={prompts}
      resources={resources}
      siblings={siblings}
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
