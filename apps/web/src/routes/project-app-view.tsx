import {
  getGatewayClientId,
  stripToolNamespace,
} from "@decocms/mcp-utils/aggregate";
import { stripMcpServerPrefix } from "@/lib/tool-namespace";
import {
  useProjectContext,
  useMCPClient,
  useMCPToolsList,
  useMCPToolCall,
  parseDevConnectionId,
} from "@/sdk";
import { useSandboxLifecycle } from "@/components/sandbox/hooks/sandbox-lifecycle-context";
import type {
  McpUiDisplayMode,
  McpUiMessageRequest,
} from "@modelcontextprotocol/ext-apps";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { contentBlocksToTiptapDoc } from "@decocms/shared/mcp-apps/content-blocks";
import { MCPAppRenderer } from "@/mcp-apps/mcp-app-renderer";
import {
  getUIResourceUri,
  MCP_APP_DISPLAY_MODES,
} from "@decocms/shared/mcp-apps/types";
import { useChatStream, useChatPrefs } from "@/components/chat/context.tsx";
import { usePanelActions } from "@/layouts/shell-layout";
import { resolveAppNavigateTarget } from "@/routes/project-app-navigate.ts";
import { findProjectAppTool } from "@/routes/project-app-tool";
import { useT } from "@/i18n/use-t.ts";

const EMPTY_TOOL_INPUT: Record<string, unknown> = {};

function AppRenderer({
  client,
  resourceURI,
  tool,
  connectionId,
  orgId,
  args,
}: {
  client: ReturnType<typeof useMCPClient>;
  resourceURI: string;
  tool: {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
  connectionId: string;
  orgId?: string;
  args?: Record<string, unknown>;
}) {
  const { sendMessage } = useChatStream();
  const { setAppContext, clearAppContext } = useChatPrefs();
  const { openSidePanel, openTab } = usePanelActions();
  const sourceId = `${connectionId}:${tool.name}`;

  const handleRequestDisplayMode = (
    mode: McpUiDisplayMode,
  ): McpUiDisplayMode => {
    if (mode === "inline") {
      openTab("0");
      return "inline";
    }
    return "fullscreen";
  };
  const toolInput = args ?? EMPTY_TOOL_INPUT;
  const { data: toolResult } = useMCPToolCall({
    client,
    toolName: tool.name,
    toolArguments: toolInput,
  });

  const clientId = getGatewayClientId(tool._meta);
  const strippedName = stripToolNamespace(tool.name, clientId);
  const strippedTool: Tool = {
    ...tool,
    name: strippedName,
    inputSchema: (tool.inputSchema as Tool["inputSchema"]) ?? {
      type: "object" as const,
    },
  };

  const handleAppMessage = (params: McpUiMessageRequest["params"]) => {
    // Intercept a navigate request and drive the router instead of inserting
    // it into chat; any other message falls through to the normal path.
    const navigateResult = resolveAppNavigateTarget(params.content);
    if (navigateResult.isNavigate) {
      if (navigateResult.tab) openTab(navigateResult.tab);
      return;
    }
    const doc = contentBlocksToTiptapDoc(params.content);
    if (doc.content.length > 0) {
      openSidePanel("chat");
      sendMessage({ tiptapDoc: doc });
    }
  };

  return (
    <MCPAppRenderer
      resourceURI={resourceURI}
      orgId={orgId}
      toolInfo={{ tool: strippedTool }}
      toolInput={toolInput}
      toolResult={toolResult}
      displayMode="fullscreen"
      minHeight={MCP_APP_DISPLAY_MODES.fullscreen.minHeight}
      maxHeight={MCP_APP_DISPLAY_MODES.fullscreen.maxHeight}
      client={client}
      onMessage={handleAppMessage}
      onUpdateModelContext={(params) => setAppContext(sourceId, params)}
      onTeardown={() => clearAppContext(sourceId)}
      onRequestDisplayMode={handleRequestDisplayMode}
      className="h-full"
    />
  );
}

export function AppViewContent({
  connectionId,
  toolName,
  args,
}: {
  connectionId: string;
  toolName: string;
  args?: Record<string, unknown>;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const lifecycle = useSandboxLifecycle();
  // A dev view (`dev_<id>`) against a user-desktop sandbox renders against the
  // loopback dev server, which the cloud proxy can't reach. The browser is
  // co-located with the daemon, so connect directly to the previewUrl (deco dev
  // server CORS is `*`). Gated on a dev connection id, so regular connection UIs
  // and agent-sandbox dev views (public previewUrl) keep the cloud route.
  const devMcpUrl =
    parseDevConnectionId(connectionId) &&
    lifecycle.vmEntry?.sandboxProviderKind === "user-desktop" &&
    lifecycle.previewUrl
      ? `${lifecycle.previewUrl.replace(/\/+$/, "")}/api/mcp`
      : undefined;
  const client = useMCPClient({
    connectionId,
    orgId: org.id,
    orgSlug: org.slug,
    mcpUrl: devMcpUrl,
  });
  const { data: toolsResult } = useMCPToolsList({ client });

  const decodedToolName = stripMcpServerPrefix(decodeURIComponent(toolName));

  const tool = findProjectAppTool(toolsResult.tools, decodedToolName);

  const resourceURI = tool?._meta ? getUIResourceUri(tool._meta) : undefined;

  if (!tool || !resourceURI) {
    return (
      <div className="flex h-full w-full items-center justify-center px-6 text-center">
        <div className="max-w-sm space-y-1">
          <p className="text-sm font-medium text-foreground">
            {t("routes.projectAppView.unavailableTitle")}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("routes.projectAppView.unavailableDescription")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <AppRenderer
      client={client}
      resourceURI={resourceURI}
      tool={tool}
      connectionId={connectionId}
      orgId={org.id}
      args={args}
    />
  );
}
