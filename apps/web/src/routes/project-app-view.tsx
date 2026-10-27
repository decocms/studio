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
} from "@/sdk";
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
import {
  parseAppArgs,
  resolveAppArgs,
  resolveAppNavigateTarget,
} from "@/routes/project-app-navigate.ts";
import { ConnectSourceDialog } from "@/routes/reports-onboarding/connect-source-dialog.tsx";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

function AppRenderer({
  client,
  resourceURI,
  tool,
  connectionId,
  orgId,
  args,
  searchArgs,
}: {
  client: ReturnType<typeof useMCPClient>;
  resourceURI: string;
  tool: {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    annotations?: { readOnlyHint?: boolean };
    _meta?: Record<string, unknown>;
  };
  connectionId: string;
  orgId?: string;
  args?: Record<string, unknown>;
  searchArgs?: string;
}) {
  const navigate = useNavigate();
  const { sendMessage } = useChatStream();
  const { setAppContext, clearAppContext } = useChatPrefs();
  const { openSidePanel, openTab, closeTab } = usePanelActions();
  const sourceId = `${connectionId}:${tool.name}`;
  // A `field`-carrying connect-sources navigate opens the source's connect
  // dialog right here, over the app view — swapping the whole panel to the
  // onboarding-style tab just to show one dialog reads as broken.
  const [connectSourceField, setConnectSourceField] = useState<string | null>(
    null,
  );

  const handleRequestDisplayMode = (
    mode: McpUiDisplayMode,
  ): McpUiDisplayMode => {
    if (mode === "inline") {
      closeTab();
      return "inline";
    }
    return "fullscreen";
  };
  const [initialSearchArgs] = useState(searchArgs);
  const toolInput = {
    ...args,
    ...(tool.annotations?.readOnlyHint && parseAppArgs(initialSearchArgs)),
  };
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
    const appArgs = resolveAppArgs(params.content);
    if (appArgs) {
      navigate({
        to: ".",
        search: (prev) => ({ ...prev, args: appArgs }),
        replace: true,
      });
      return;
    }
    // Intercept a navigate request and drive the router instead of inserting
    // it into chat; any other message falls through to the normal path.
    const navigateResult = resolveAppNavigateTarget(params.content);
    if (navigateResult.isNavigate) {
      // A specific source to connect → just open its connect dialog in place;
      // only the generic (field-less) connect-sources request still opens the
      // full card-grid tab.
      if (navigateResult.tab === "connect-sources" && navigateResult.field) {
        setConnectSourceField(navigateResult.field);
      } else if (navigateResult.tab) {
        // Opening a card pushes a history entry, so Back returns to the app.
        openTab(
          navigateResult.tab,
          navigateResult.task
            ? { taskKey: navigateResult.task, replace: false }
            : undefined,
        );
      }
      return;
    }
    const doc = contentBlocksToTiptapDoc(params.content);
    if (doc.content.length > 0) {
      openSidePanel();
      sendMessage({ tiptapDoc: doc });
    }
  };

  return (
    <>
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
      {connectSourceField && (
        <ConnectSourceDialog
          field={connectSourceField}
          onClose={() => setConnectSourceField(null)}
        />
      )}
    </>
  );
}

export function AppViewContent({
  connectionId,
  toolName,
  args,
  searchArgs,
}: {
  connectionId: string;
  toolName: string;
  args?: Record<string, unknown>;
  searchArgs?: string;
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
      searchArgs={searchArgs}
    />
  );
}
