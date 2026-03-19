/**
 * Hook to install an MCP Server from registry by binding type.
 * Provides inline installation without navigation.
 */

import { toast } from "sonner";
import type { RegistryItem } from "@/web/components/store/types";
import { useRegistryConnections } from "@/web/hooks/use-binding";
import { authClient } from "@/web/lib/auth-client";
import {
  useConnectionActions,
  useConnections,
  useProjectContext,
  type ConnectionEntity,
} from "@decocms/mesh-sdk";
import { extractConnectionData } from "@/web/utils/extract-connection-data";
import {
  findListToolName,
  extractItemsFromResponse,
  callRegistryTool,
} from "@/web/utils/registry-utils";

interface InstallResult {
  id: string;
  connection: ConnectionEntity;
}

interface UseInstallFromRegistryResult {
  /**
   * Install an MCP Server by binding type (e.g., "@deco/database").
   * Returns the new connection data if successful, undefined otherwise.
   */
  installByBinding: (bindingType: string) => Promise<InstallResult | undefined>;
  /**
   * Whether an installation is in progress
   */
  isInstalling: boolean;
}

/**
 * Normalize MCP Server name format, ensuring @ prefix is present
 * @example
 * - "@deco/database" -> "@deco/database" (unchanged)
 * - "deco/database" -> "@deco/database" (adds @)
 */
function parseServerName(serverName: string): string {
  return serverName.startsWith("@") ? serverName : `@${serverName}`;
}

/**
 * Hook that provides inline MCP Server installation from registry.
 * Use this when you want to install a specific MCP Server without navigating away.
 */
export function useInstallFromRegistry(): UseInstallFromRegistryResult {
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const actions = useConnectionActions();

  // Get all connections and filter to registry connections
  const allConnections = useConnections();
  const registryConnections = useRegistryConnections(allConnections);

  // Installation function - queries registries directly with MCP Server name filter
  const installByBinding = async (
    bindingType: string,
  ): Promise<InstallResult | undefined> => {
    if (!org || !session?.user?.id) {
      toast.error("Not authenticated");
      return undefined;
    }

    const parsedServerName = parseServerName(bindingType);

    // Query all registries in parallel to find the MCP Server
    const results = await Promise.all(
      registryConnections.map(async (registryConnection) => {
        const listToolName = findListToolName(registryConnection.tools);
        if (!listToolName) return null;

        try {
          const result = await callRegistryTool(
            registryConnection.id,
            org.id,
            listToolName,
            {
              where: { appName: parsedServerName },
            },
          );
          const items = extractItemsFromResponse<RegistryItem>(result ?? []);
          return items[0] ?? null;
        } catch {
          // Silently fail for individual registries - we'll try others
          return null;
        }
      }),
    );

    // Find the first successful result
    const registryItem = results.find(
      (item): item is RegistryItem => item !== null,
    );

    if (!registryItem) {
      toast.error(`MCP Server not found in registry: ${bindingType}`);
      return undefined;
    }

    // Extract connection data
    const connectionData = extractConnectionData(
      registryItem,
      org.id,
      session.user.id,
    );

    // Validate connection data based on type
    const isStdioConnection = connectionData.connection_type === "STDIO";
    const hasUrl = Boolean(connectionData.connection_url);
    const hasStdioConfig =
      isStdioConnection &&
      connectionData.connection_headers &&
      typeof connectionData.connection_headers === "object" &&
      "command" in connectionData.connection_headers;

    if (!hasUrl && !hasStdioConfig) {
      toast.error(
        "This MCP Server cannot be connected: no connection method available",
      );
      return undefined;
    }

    await actions.create.mutateAsync(connectionData);
    // Success toast is handled by the mutation's onSuccess
    // Return full connection data so caller doesn't need to fetch from collection
    return {
      id: connectionData.id,
      connection: connectionData as ConnectionEntity,
    };
  };

  return {
    installByBinding,
    isInstalling: actions.create.isPending,
  };
}
