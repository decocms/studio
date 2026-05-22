import {
  getGatewayClientId,
  stripToolNamespace,
} from "@decocms/mcp-utils/aggregate";
import { stripMcpServerPrefix } from "@/web/lib/tool-namespace";
import {
  useProjectContext,
  useMCPClient,
  useMCPToolsList,
  useMCPToolCallQuery,
} from "@decocms/mesh-sdk";
import type {
  McpUiDisplayMode,
  McpUiMessageRequest,
} from "@modelcontextprotocol/ext-apps";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { contentBlocksToTiptapDoc } from "@/mcp-apps/content-blocks.ts";
import { MCPAppRenderer } from "@/mcp-apps/mcp-app-renderer.tsx";
import { getUIResourceUri, MCP_APP_DISPLAY_MODES } from "@/mcp-apps/types.ts";
import { useChatStream, useChatPrefs } from "@/web/components/chat/context.tsx";
import { usePanelActions } from "@/web/layouts/shell-layout";

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
  const { setChatOpen, openTab } = usePanelActions();
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
  const { data: toolResult } = useMCPToolCallQuery({
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
    const doc = contentBlocksToTiptapDoc(params.content);
    if (doc.content.length > 0) {
      setChatOpen(true);
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
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const { data: toolsResult } = useMCPToolsList({ client });

  const decodedToolName = stripMcpServerPrefix(decodeURIComponent(toolName));

  // Try exact match first. If that fails, the decoded name may be the original
  // (un-namespaced) tool name while the tools list has gateway-namespaced names
  // (e.g. "render_html" vs "conn-abc_render_html"), or vice versa. Fall back to
  // matching by the base name with the gateway namespace stripped from both sides.
  const tool =
    toolsResult.tools.find((t) => t.name === decodedToolName) ??
    toolsResult.tools.find((t) => {
      const clientId = getGatewayClientId(t._meta);
      if (!clientId) return false;
      // Case 1: decoded name is the base name, tool list has namespaced names
      const baseName = stripToolNamespace(t.name, clientId);
      if (baseName === decodedToolName) return true;
      // Case 2: decoded name has namespace prefix, tool list has base names
      const decodedBase = stripToolNamespace(decodedToolName, clientId);
      if (decodedBase !== decodedToolName && t.name === decodedBase)
        return true;
      return false;
    });

  const resourceURI = tool?._meta ? getUIResourceUri(tool._meta) : undefined;

  if (!tool || !resourceURI) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <p className="text-sm text-muted-foreground">
          Tool &quot;{decodedToolName}&quot; not found or has no UI
        </p>
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
