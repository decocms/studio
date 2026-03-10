import { MCPAppRenderer } from "@/mcp-apps/mcp-app-renderer.tsx";
import { getUIResourceUri, MCP_APP_DISPLAY_MODES } from "@/mcp-apps/types.ts";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@deco/ui/components/alert.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { Loading01 } from "@untitledui/icons";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@deco/ui/components/breadcrumb.tsx";
import {
  AlertCircle,
  Box,
  Clock,
  Code01,
  Copy01,
  Database01,
  LayersTwo01,
  Play,
  StopCircle,
} from "@untitledui/icons";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpUiMessageRequest } from "@modelcontextprotocol/ext-apps";
import { Suspense, useState } from "react";
import { toast } from "sonner";
import { ViewLayout } from "./layout";
import {
  OAuthAuthenticationState,
  ManualAuthRequiredState,
} from "./connection/settings-tab";
import { useMCPAuthStatus } from "@/web/hooks/use-mcp-auth-status";
import {
  ORG_ADMIN_PROJECT_SLUG,
  useConnection,
  useMCPClient,
  useMCPToolsListQuery,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { contentBlocksToTiptapDoc } from "@/mcp-apps/content-blocks.ts";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { ToolAnnotationBadges } from "@/web/components/tools/tools-list.tsx";
import { useChatStable } from "@/web/components/chat/context.tsx";
import { useDecoChatOpen } from "@/web/hooks/use-deco-chat-open.ts";
import { MonacoCodeEditor } from "./workflow/components/monaco-editor";

export interface ToolDetailsViewProps {
  itemId: string;
  onBack: () => void;
  onUpdate: (updates: Record<string, unknown>) => Promise<void>;
}

const beautifyToolName = (toolName: string) => {
  return toolName
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toLocaleLowerCase());
};

function ToolDetailsContent({
  toolName,
  connectionId,
  onBack,
}: {
  toolName: string;
  connectionId: string;
  onBack: () => void;
}) {
  const authStatus = useMCPAuthStatus({
    connectionId: connectionId,
  });

  if (!authStatus.isAuthenticated) {
    return (
      <div className="flex h-full items-center justify-center">
        {authStatus.supportsOAuth ? (
          <OAuthAuthenticationState
            onAuthenticate={() => onBack()}
            buttonText="Go back to authenticate"
          />
        ) : (
          <ManualAuthRequiredState hasReadme={false} />
        )}
      </div>
    );
  }

  return (
    <ToolDetailsAuthenticated
      key={`${connectionId}:${toolName}`}
      toolName={toolName}
      connectionId={connectionId}
    />
  );
}

function ToolDetailsAuthenticated({
  toolName,
  connectionId,
}: {
  toolName: string;
  connectionId: string;
}) {
  // Read replayId from search params to check for prefilled input
  const { replayId } = useSearch({ strict: false }) as { replayId?: string };

  // Read replay input from sessionStorage (one-time, on mount)
  const replayInput = (() => {
    if (!replayId) return null;
    const key = `replay-${replayId}`;
    const stored = sessionStorage.getItem(key);
    if (!stored) return null;
    // Clear after reading (one-time use)
    sessionStorage.removeItem(key);
    try {
      return JSON.parse(stored) as Record<string, unknown>;
    } catch {
      return null;
    }
  })();

  // Convert replay input to form-friendly format (stringify objects/arrays)
  const replayInputForForm = (() => {
    if (!replayInput) return null;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(replayInput)) {
      // Stringify objects and arrays for textarea/input fields
      if (value !== null && typeof value === "object") {
        result[key] = JSON.stringify(value, null, 2);
      } else {
        result[key] = value;
      }
    }
    return result;
  })();

  // Store only user edits; defaults are derived from the schema (no effect-driven initialization).
  // If replay input exists, use it as initial edited params (with objects/arrays stringified).
  const [editedParams, setEditedParams] = useState<Record<string, unknown>>(
    replayInputForForm ?? {},
  );
  // For tools without `inputSchema.properties`, allow free-form JSON editing (including temporarily invalid JSON while typing).
  // If replay input exists, stringify it for the raw JSON editor.
  const [rawJsonText, setRawJsonText] = useState(
    replayInput ? JSON.stringify(replayInput, null, 2) : "{}",
  );
  const [executionResult, setExecutionResult] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [rawToolResult, setRawToolResult] = useState<CallToolResult | null>(
    null,
  );
  const [lastToolInput, setLastToolInput] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [stats, setStats] = useState<{
    duration: string;
    tokens?: string;
    bytes?: string;
    cost?: string;
  } | null>(null);

  const { org } = useProjectContext();
  const connection = useConnection(connectionId);
  const { sendMessage, setAppContext, clearAppContext } = useChatStable();
  const [, setChatOpen] = useDecoChatOpen();
  const sourceId = `${connectionId}:${toolName}`;

  const client = useMCPClient({
    connectionId,
    orgId: org.id,
  });

  const toolsQuery = useMCPToolsListQuery({ client });

  // Find the tool definition
  const tool = toolsQuery.data?.tools?.find((t) => t.name === toolName);
  const uiResourceUri = getUIResourceUri(tool?._meta);

  const handleAppMessage = (params: McpUiMessageRequest["params"]) => {
    const doc = contentBlocksToTiptapDoc(params.content);
    if (doc.content.length > 0) {
      setChatOpen(true);
      sendMessage(doc);
    }
  };

  const [resultView, setResultView] = useState<"ui" | "json">("json");
  const [hasSetDefaultView, setHasSetDefaultView] = useState(false);
  // Default to UI view once the tool's resource URI becomes available
  if (uiResourceUri && !hasSetDefaultView) {
    setResultView("ui");
    setHasSetDefaultView(true);
  }

  const toolProperties = tool?.inputSchema?.properties;
  const toolPropertyKeys = toolProperties ? Object.keys(toolProperties) : [];
  const hasToolProperties = toolPropertyKeys.length > 0;

  const defaultParams: Record<string, unknown> = {};
  if (hasToolProperties && tool?.inputSchema?.properties) {
    for (const key of toolPropertyKeys) {
      defaultParams[key] = tool.inputSchema.required?.includes(key)
        ? ""
        : undefined;
    }
  }

  const hasEditedKey = (key: string) =>
    Object.prototype.hasOwnProperty.call(editedParams, key);

  const handleExecute = async () => {
    setIsExecuting(true);
    setExecutionError(null);
    setExecutionResult(null);
    setRawToolResult(null);
    setLastToolInput(null);
    setStats(null);

    const startTime = performance.now();
    try {
      if (!client) {
        throw new Error("MCP client is not available");
      }
      // Prepare arguments:
      // - If we have properties, merge derived defaults with user edits and parse object/array fields when provided as strings.
      // - Otherwise, parse the raw JSON input as the full args payload.
      const args: Record<string, unknown> = hasToolProperties
        ? { ...defaultParams, ...editedParams }
        : (() => {
            const trimmed = rawJsonText.trim();
            if (!trimmed) return {};
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === "object") {
              return parsed as Record<string, unknown>;
            }
            throw new Error("Raw JSON input must be an object.");
          })();

      if (hasToolProperties && tool?.inputSchema?.properties) {
        Object.entries(tool.inputSchema.properties).forEach(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ([key, prop]: [string, any]) => {
            if (
              (prop.type === "object" || prop.type === "array") &&
              typeof args[key] === "string"
            ) {
              try {
                args[key] = JSON.parse(args[key]);
              } catch {
                // Parsing failed, send as string (will likely fail validation but let server handle it)
              }
            }
          },
        );
      }

      const result = (await client.callTool({
        name: toolName,
        arguments: args,
      })) as CallToolResult & { structuredContent?: unknown };
      const payload = (result.structuredContent ?? result) as Record<
        string,
        unknown
      >;

      const endTime = performance.now();
      const durationMs = Math.round(endTime - startTime);

      setExecutionResult(payload);
      setRawToolResult(result);
      setLastToolInput(args);

      // Calculate mocked stats based on result size
      const resultStr = JSON.stringify(payload);
      const bytes = new TextEncoder().encode(resultStr).length;

      setStats({
        duration: `${durationMs}ms`,
        bytes: `${bytes} bytes`,
        // Mocking tokens/cost as we don't have real data for that yet
        tokens: `~${Math.ceil(bytes / 4)} tokens`,
        cost: "$0.0000",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setExecutionError(message || "Unknown error occurred");
      const endTime = performance.now();
      setStats({
        duration: `${Math.round(endTime - startTime)}ms`,
      });
    } finally {
      setIsExecuting(false);
    }
  };

  const handleInputChange = (key: string, value: unknown) => {
    setEditedParams((prev) => ({ ...prev, [key]: value }));
  };

  const handleClear = () => {
    setExecutionResult(null);
    setRawToolResult(null);
    setLastToolInput(null);
    setExecutionError(null);
    setStats(null);
  };

  const displayToolName = tool?.name ?? beautifyToolName(toolName);

  const breadcrumb = (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link
              to="/$org/$project/mcps"
              params={{ org: org.slug, project: ORG_ADMIN_PROJECT_SLUG }}
            >
              Connections
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        {connection && (
          <>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link
                  to="/$org/$project/mcps/$connectionId"
                  params={{
                    org: org.slug,
                    project: ORG_ADMIN_PROJECT_SLUG,
                    connectionId,
                  }}
                  search={{ tab: "tools" }}
                >
                  {connection.title}
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
          </>
        )}
        <BreadcrumbItem>
          <BreadcrumbPage>{displayToolName}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );

  return (
    <ViewLayout breadcrumb={breadcrumb}>
      <div className="grid grid-cols-1 lg:grid-cols-[30%_70%] h-full">
        {/* Left Panel - Tool Info, Parameters & Execute */}
        <div className="flex flex-col border-r border-border overflow-hidden">
          <div className="flex-1 overflow-auto">
            {/* Tool Header */}
            <div className="flex flex-col gap-4 p-6 border-b border-border min-h-28">
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-3">
                  <IntegrationIcon
                    icon={connection?.icon || null}
                    name={connection?.title || toolName}
                    size="sm"
                    className="shadow-sm shrink-0"
                  />
                  <h1 className="text-lg font-medium text-foreground leading-none">
                    {toolName}
                  </h1>
                  {/* MCP Status */}
                  <div className="flex items-center gap-2 px-2.5 py-1 bg-muted/50 rounded-md h-fit">
                    {toolsQuery.isSuccess ? (
                      <div className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse shrink-0" />
                    ) : toolsQuery.isLoading ? (
                      <Loading01
                        size={10}
                        className="animate-spin text-yellow-500 shrink-0"
                      />
                    ) : (
                      <div className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" />
                    )}
                    <span className="font-mono text-xs capitalize text-muted-foreground leading-none">
                      {toolsQuery.isSuccess
                        ? "ready"
                        : toolsQuery.isLoading
                          ? "connecting"
                          : "error"}
                    </span>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {tool?.description || "No description available"}
                </p>
              </div>
            </div>

            {/* Parameters Section */}
            <div className="flex flex-col p-6 gap-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-foreground uppercase tracking-wide">
                  Parameters
                </h2>
                {tool?.inputSchema?.required &&
                  tool.inputSchema.required.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      <span className="text-red-500">*</span> Required
                    </span>
                  )}
              </div>

              <div className="space-y-4">
                {hasToolProperties && tool?.inputSchema?.properties ? (
                  Object.entries(tool.inputSchema.properties).map(
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    ([key, prop]: [string, any]) => (
                      <div key={key} className="space-y-2">
                        <div className="flex items-center justify-between">
                          <label className="text-sm font-medium leading-none flex items-center gap-1.5">
                            {key}
                            {tool.inputSchema?.required?.includes(key) && (
                              <span className="text-red-500 text-xs">*</span>
                            )}
                          </label>
                          <span className="text-xs text-muted-foreground font-mono">
                            {prop.type}
                          </span>
                        </div>
                        {prop.description && (
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            {prop.description}
                          </p>
                        )}
                        {prop.type === "object" || prop.type === "array" ? (
                          <Textarea
                            className="font-mono text-xs"
                            value={
                              hasEditedKey(key)
                                ? ((editedParams[key] as string) ?? "")
                                : ((defaultParams[key] as string) ?? "")
                            }
                            onChange={(e) =>
                              handleInputChange(key, e.target.value)
                            }
                            placeholder={`Enter ${key} as JSON...`}
                            rows={3}
                          />
                        ) : prop.type === "boolean" ? (
                          <Select
                            value={
                              hasEditedKey(key)
                                ? String(editedParams[key] ?? "")
                                : ""
                            }
                            onValueChange={(v) =>
                              handleInputChange(key, v === "true")
                            }
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select true or false..." />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="true">true</SelectItem>
                              <SelectItem value="false">false</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input
                            value={
                              hasEditedKey(key)
                                ? ((editedParams[key] as string) ?? "")
                                : ((defaultParams[key] as string) ?? "")
                            }
                            onChange={(e) =>
                              handleInputChange(key, e.target.value)
                            }
                            placeholder={`Enter ${key}...`}
                          />
                        )}
                      </div>
                    ),
                  )
                ) : tool?.inputSchema && !hasToolProperties ? (
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Raw JSON Input
                    </label>
                    <Textarea
                      className="font-mono text-xs min-h-[120px]"
                      value={rawJsonText}
                      onChange={(e) => setRawJsonText(e.target.value)}
                      placeholder='e.g. { "foo": "bar" }'
                    />
                  </div>
                ) : (
                  <div className="flex items-center justify-center p-8 bg-muted/30 rounded-lg border border-dashed border-border">
                    <p className="text-sm text-muted-foreground">
                      No parameters required
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right Panel - Results Only */}
        <div className="flex flex-col h-full overflow-hidden">
          {/* Results Header */}
          <div className="flex items-center justify-between px-4 h-14 border-t lg:border-t-0 border-b border-border bg-background">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-medium text-foreground uppercase tracking-wide">
                Result
              </h2>
              <ToolAnnotationBadges
                annotations={tool?.annotations}
                _meta={tool?._meta as Record<string, unknown> | undefined}
              />
            </div>

            {/* Execution Stats */}
            {stats && (
              <div className="flex items-center gap-3 text-xs">
                <div className="flex items-center gap-1.5">
                  <Clock className="h-3 w-3 text-muted-foreground" />
                  <span className="font-mono text-foreground">
                    {stats.duration}
                  </span>
                </div>
                {stats.tokens && (
                  <div className="flex items-center gap-1.5">
                    <Box className="h-3 w-3 text-muted-foreground" />
                    <span className="font-mono text-foreground">
                      {stats.tokens}
                    </span>
                  </div>
                )}
                {stats.bytes && (
                  <div className="flex items-center gap-1.5">
                    <Database01 className="h-3 w-3 text-muted-foreground" />
                    <span className="font-mono text-foreground">
                      {stats.bytes}
                    </span>
                  </div>
                )}
                {stats.cost && (
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-foreground">
                      {stats.cost}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Execute Buttons Row */}
          <div className="flex items-center justify-end lg:justify-between px-4 h-14 border-b border-border bg-background">
            <div className="flex items-center gap-2 w-full lg:w-auto">
              {isExecuting ? (
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-8 gap-2 flex-1 lg:flex-none"
                  onClick={handleClear}
                >
                  <StopCircle className="h-3.5 w-3.5" />
                  Cancel
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="default"
                  className="h-8 gap-2 flex-1 lg:flex-none"
                  onClick={handleExecute}
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                  Execute Tool
                </Button>
              )}
            </div>
            {/* View toggle: UI / JSON */}
            {uiResourceUri && (
              <TooltipProvider>
                <div className="flex items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon"
                        variant={resultView === "ui" ? "secondary" : "ghost"}
                        className="h-8 w-8"
                        onClick={() => setResultView("ui")}
                      >
                        <LayersTwo01 size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Interactive view</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon"
                        variant={resultView === "json" ? "secondary" : "ghost"}
                        className="h-8 w-8"
                        onClick={() => setResultView("json")}
                      >
                        <Code01 size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>JSON view</TooltipContent>
                  </Tooltip>
                </div>
              </TooltipProvider>
            )}
          </div>

          {/* Error Alert */}
          {executionError && (
            <div className="px-6 py-4 bg-background">
              <Alert variant="destructive">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle className="mb-0">Execution Failed</AlertTitle>
                  </div>
                  <AlertDescription className="text-xs text-destructive">
                    {executionError}
                  </AlertDescription>
                </div>
              </Alert>
            </div>
          )}

          {/* Results Content */}
          <div className="relative flex-1 overflow-auto bg-muted/50">
            {uiResourceUri && resultView === "ui" && client ? (
              <Suspense
                fallback={
                  <div className="flex items-center justify-center h-48">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <div className="size-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      <span className="text-sm">Loading app...</span>
                    </div>
                  </div>
                }
              >
                <MCPAppRenderer
                  resourceURI={uiResourceUri}
                  toolInfo={
                    tool
                      ? {
                          tool: tool as Tool,
                        }
                      : undefined
                  }
                  toolInput={lastToolInput ?? undefined}
                  toolResult={rawToolResult ?? undefined}
                  displayMode="fullscreen"
                  minHeight={MCP_APP_DISPLAY_MODES.view.minHeight}
                  maxHeight={MCP_APP_DISPLAY_MODES.view.maxHeight}
                  client={client}
                  onMessage={handleAppMessage}
                  onUpdateModelContext={(params) =>
                    setAppContext(sourceId, params)
                  }
                  onTeardown={() => clearAppContext(sourceId)}
                  className="h-full"
                />
              </Suspense>
            ) : executionResult ? (
              <>
                <MonacoCodeEditor
                  code={JSON.stringify(executionResult, null, 2)}
                  language="json"
                  height="100%"
                  readOnly
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="absolute top-4 right-4 h-8 w-8 bg-background/80 hover:bg-background border border-border shadow-sm"
                  onClick={() => {
                    navigator.clipboard.writeText(
                      JSON.stringify(executionResult, null, 2),
                    );
                    toast.success("Copied to clipboard");
                  }}
                >
                  <Copy01 className="h-3.5 w-3.5" />
                </Button>
              </>
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
                <Code01 className="h-12 w-12 mb-3 opacity-40" />
                <p className="text-sm">Run the tool to see results</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </ViewLayout>
  );
}

export function ToolDetailsView({
  itemId: toolName,
  onBack,
}: ToolDetailsViewProps) {
  const params = useParams({ strict: false });
  const connectionId = params.connectionId;

  const connection = useConnection(connectionId);

  if (!connection || !connectionId) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-2 text-center">
          <h3 className="text-lg font-semibold">Connection not found</h3>
          <p className="text-sm text-muted-foreground">
            This connection may have been deleted or you may not have access.
          </p>
        </div>
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Loading01 size={32} className="animate-spin text-muted-foreground" />
        </div>
      }
    >
      <ToolDetailsContent
        toolName={toolName}
        connectionId={connectionId}
        onBack={onBack}
      />
    </Suspense>
  );
}
