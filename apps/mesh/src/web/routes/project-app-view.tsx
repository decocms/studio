import { Suspense } from "react";
import { useParams } from "@tanstack/react-router";
import {
  useProjectContext,
  useMCPClient,
  useConnection,
  useMCPToolCall,
} from "@decocms/mesh-sdk";
import { MCPAppRenderer } from "@/mcp-apps/mcp-app-renderer.tsx";
import { getUIResourceUri, MCP_APP_DISPLAY_MODES } from "@/mcp-apps/types.ts";
import { ErrorBoundary } from "@/web/components/error-boundary.tsx";

const EMPTY_TOOL_INPUT: Record<string, unknown> = {};

function AppRenderer({
  client,
  toolName,
  resourceURI,
}: {
  client: ReturnType<typeof useMCPClient>;
  toolName: string;
  resourceURI: string;
}) {
  const { data: toolResult } = useMCPToolCall({
    client,
    toolName,
    toolArguments: EMPTY_TOOL_INPUT,
  });

  return (
    <MCPAppRenderer
      resourceURI={resourceURI}
      toolName={toolName}
      toolInput={EMPTY_TOOL_INPUT}
      toolResult={toolResult}
      displayMode="fullscreen"
      minHeight={MCP_APP_DISPLAY_MODES.fullscreen.minHeight}
      maxHeight={MCP_APP_DISPLAY_MODES.fullscreen.maxHeight}
      client={client}
      className="h-full"
    />
  );
}

function AppViewContent({
  connectionId,
  toolName,
}: {
  connectionId: string;
  toolName: string;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({ connectionId, orgId: org.id });
  const connection = useConnection(connectionId);

  const decodedToolName = decodeURIComponent(toolName);

  const tool = (connection?.tools ?? []).find(
    (t: { name: string }) => t.name === decodedToolName,
  );

  const resourceURI = tool?._meta ? getUIResourceUri(tool._meta) : undefined;

  if (!connection) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground">Connection not found</p>
      </div>
    );
  }

  if (!tool || !resourceURI) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground">
          Tool &quot;{decodedToolName}&quot; not found or has no UI
        </p>
      </div>
    );
  }

  return (
    <AppRenderer
      client={client}
      toolName={decodedToolName}
      resourceURI={resourceURI}
    />
  );
}

export default function ProjectAppView() {
  const { connectionId, toolName } = useParams({
    from: "/shell/$org/$project/apps/$connectionId/$toolName",
  });

  return (
    <ErrorBoundary key={`${connectionId}:${toolName}`} fallback={undefined}>
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-full">
            <div className="flex items-center gap-2 text-muted-foreground">
              <div className="size-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
              <span className="text-sm">Loading app...</span>
            </div>
          </div>
        }
      >
        <AppViewContent connectionId={connectionId} toolName={toolName} />
      </Suspense>
    </ErrorBoundary>
  );
}
