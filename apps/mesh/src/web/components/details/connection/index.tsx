import { EmptyState } from "@/web/components/empty-state.tsx";
import { ErrorBoundary } from "@/web/components/error-boundary";
import {
  envVarsToRecord,
  recordToEnvVars,
  type EnvVar,
} from "@/web/components/env-vars-editor";
import { useBindingConnections } from "@/web/hooks/use-binding";
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
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Loading01 } from "@untitledui/icons";
import { Suspense, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { ViewLayout } from "../layout";
import { ConnectionActivity } from "./connection-activity.tsx";
import { ConnectionAgentsPanel } from "./connection-agents-panel.tsx";
import { ConnectionCapabilities } from "./connection-capabilities.tsx";
import { ConnectionDetailHeader } from "./connection-detail-header.tsx";
import { ConnectionInfoCard } from "./connection-info-card.tsx";
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
  onUpdate,
  isUpdating,
  tools,
  prompts,
  resources,
}: {
  connection: ConnectionEntity;
  connectionId: string;
  org: string;
  onUpdate: (connection: Partial<ConnectionEntity>) => Promise<void>;
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
}) {
  const navigate = useNavigate({ from: "/$org/$project/mcps/$connectionId" });
  const queryClient = useQueryClient();
  const connectionActions = useConnectionActions();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [disconnectConfirmOpen, setDisconnectConfirmOpen] = useState(false);

  const authStatus = useMCPAuthStatus({
    connectionId: connectionId,
  });
  // VIRTUAL connections are always "authenticated" - they don't have OAuth
  // They're internal connections that aggregate tools from other connections
  const isVirtualConnection = connection?.connection_type === "VIRTUAL";
  // A connection is authenticated if the MCP proxy responds OK AND the
  // connection status is not "inactive" (connections needing an API key may
  // respond OK to initialize but fail on actual tool calls).
  const isMCPAuthenticated =
    isVirtualConnection ||
    (authStatus.isAuthenticated && connection?.status !== "inactive");

  // Check if connection has MCP binding for configuration
  const mcpBindingConnections = useBindingConnections({
    connections: [connection],
    binding: "MCP",
  });
  const hasMcpBinding = mcpBindingConnections.length > 0;

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

  const handleDisconnect = async () => {
    await connectionActions.delete.mutateAsync(connection.id);
    navigate({
      to: "/$org/$project/mcps",
      params: { org, project: ORG_ADMIN_PROJECT_SLUG },
    });
  };

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
    <>
      {/* Disconnect Confirmation */}
      <AlertDialog
        open={disconnectConfirmOpen}
        onOpenChange={setDisconnectConfirmOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect connection?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove{" "}
              <span className="font-medium text-foreground">
                {connection.title}
              </span>
              . This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDisconnect}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Settings Sheet */}
      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent
          side="right"
          className="sm:max-w-[520px] p-0 flex flex-col gap-0 overflow-hidden"
        >
          <SheetHeader className="px-6 py-4 border-b border-border shrink-0">
            <SheetTitle className="text-base">{connection.title}</SheetTitle>
            <SheetDescription className="text-xs">
              Update URL, authentication, and other settings
            </SheetDescription>
          </SheetHeader>
          <Form {...form}>
            <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-6">
              <div className="flex flex-col gap-4">
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
                connection={connection}
                hasOAuthToken={authStatus.hasOAuthToken}
                onReauthenticate={handleAuthenticate}
                onRemoveOAuth={handleRemoveOAuth}
              />
              <SettingsTab
                connection={connection}
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
            </div>
          </Form>
        </SheetContent>
      </Sheet>

      {/* Main page */}
      <ViewLayout breadcrumb={breadcrumb}>
        <div className="flex flex-col h-full overflow-hidden">
          <ConnectionDetailHeader
            connection={connection}
            onOpenSettings={() => setSettingsOpen(true)}
            onDisconnect={() => setDisconnectConfirmOpen(true)}
          />
          <div className="flex-1 overflow-auto">
            <div className="flex gap-6 p-6">
              {/* Left column */}
              <div className="flex-1 min-w-0 flex flex-col gap-5">
                <ConnectionActivity connectionId={connectionId} />
                <ConnectionCapabilities
                  tools={tools}
                  prompts={prompts}
                  resources={resources}
                  connectionId={connectionId}
                  org={org}
                />
              </div>
              {/* Right column */}
              <div className="w-72 shrink-0 flex flex-col gap-5">
                <ConnectionAgentsPanel connection={connection} />
                <ConnectionInfoCard
                  connection={connection}
                  onOpenSettings={() => setSettingsOpen(true)}
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
  const navigate = useNavigate({ from: "/$org/$project/mcps/$connectionId" });
  const { connectionId, org } = useParams({
    from: "/shell/$org/$project/mcps/$connectionId",
  });
  const { org: projectOrg } = useProjectContext();

  const connection = useConnection(connectionId);
  const actions = useConnectionActions();

  // Get MCP client for this connection (suspense-based)
  const client = useMCPClient({
    connectionId,
    orgId: projectOrg.id,
  });

  // Fetch tools - uses cached if available, otherwise fetches dynamically
  // VIRTUAL connections always fetch dynamically because:
  // 1. Their tools column contains virtual tool definitions (code), not cached downstream tools
  // 2. The actual tools list (virtual + downstream) comes from the MCP proxy
  const isVirtualConnection = connection?.connection_type === "VIRTUAL";
  const hasCachedTools =
    !isVirtualConnection && connection?.tools && connection.tools.length > 0;
  const { data: toolsData } = useMCPToolsListQuery({
    client,
    enabled: !hasCachedTools,
  });

  const tools = hasCachedTools
    ? (connection.tools ?? [])
    : (toolsData?.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown> | undefined,
        annotations: t.annotations,
        _meta: t._meta as Record<string, unknown> | undefined,
      }));

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
      onUpdate={handleUpdateConnection}
      isUpdating={actions.update.isPending}
      tools={tools}
      prompts={prompts}
      resources={resources}
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
