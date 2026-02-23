/**
 * Preview Layout — LayoutComponent
 *
 * Self-contained layout for the preview plugin.
 * Resolves the connection from plugin config, reads .deco/preview.json,
 * and renders either PreviewSetup or PreviewFrame.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useMCPClientOptional,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { Loading01 } from "@untitledui/icons";
import { KEYS } from "../lib/query-keys";
import {
  usePreviewConfig,
  type PreviewConfig,
} from "../hooks/use-preview-config";
import PreviewSetup from "./preview-setup";
import PreviewFrame from "./preview-frame";

type PluginConfigOutput = {
  config: {
    id: string;
    projectId: string;
    pluginId: string;
    connectionId: string | null;
    settings: Record<string, unknown> | null;
  } | null;
};

export default function PreviewLayout() {
  const { org, project } = useProjectContext();
  const pluginId = "preview";

  // Saved config override (set when user saves from setup screen)
  const [savedConfig, setSavedConfig] = useState<PreviewConfig | null>(null);

  // Get self MCP client to read plugin config
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  // Fetch the plugin's connection config
  const { data: pluginConfig, isLoading: isLoadingConfig } = useQuery({
    queryKey: KEYS.pluginConfig(project.id ?? "", pluginId),
    queryFn: async () => {
      const result = (await selfClient.callTool({
        name: "PROJECT_PLUGIN_CONFIG_GET",
        arguments: { projectId: project.id, pluginId },
      })) as { structuredContent?: unknown };
      return (result.structuredContent ?? result) as PluginConfigOutput;
    },
    enabled: !!project.id,
  });

  const configuredConnectionId = pluginConfig?.config?.connectionId ?? null;

  // Create MCP client for the configured connection
  const connectionClient = useMCPClientOptional({
    connectionId: configuredConnectionId ?? undefined,
    orgId: org.id,
  });

  // Read .deco/preview.json
  const { data: previewConfig, isLoading: isLoadingPreviewConfig } =
    usePreviewConfig(connectionClient, configuredConnectionId);

  // Use saved config (from setup) or loaded config
  const activeConfig = savedConfig ?? previewConfig;

  // Loading state
  if (isLoadingConfig || isLoadingPreviewConfig) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <Loading01
          size={32}
          className="animate-spin text-muted-foreground mb-4"
        />
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  // No connection configured
  if (!configuredConnectionId || !connectionClient) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <div className="text-center max-w-md">
          <h2 className="text-lg font-semibold mb-2">Preview Not Available</h2>
          <p className="text-sm text-muted-foreground">
            No local-dev connection is configured for this project. Add a
            local-dev project first.
          </p>
        </div>
      </div>
    );
  }

  // No preview config yet — show setup
  if (!activeConfig) {
    return (
      <PreviewSetup
        client={connectionClient}
        connectionId={configuredConnectionId}
        onConfigSaved={setSavedConfig}
      />
    );
  }

  // Config exists — show preview frame
  return (
    <PreviewFrame
      client={connectionClient}
      config={activeConfig}
      connectionId={configuredConnectionId}
    />
  );
}
