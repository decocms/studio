/**
 * Hook to install an MCP Server from registry by binding type.
 * Provides inline installation without navigation.
 */

import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import {
  useConnectionActions,
  useProjectContext,
  type ConnectionEntity,
} from "@/sdk";
import { extractConnectionData } from "@/utils/extract-connection-data";
import { useStudioTools } from "@/lib/studio-tools";

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
 * Hook that provides inline MCP Server installation from registry.
 * Use this when you want to install a specific MCP Server without navigating away.
 */
export function useInstallFromRegistry(): UseInstallFromRegistryResult {
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const actions = useConnectionActions();

  const studio = useStudioTools();

  // Resolve the requested MCP in the Deco catalog.
  const installByBinding = async (
    bindingType: string,
  ): Promise<InstallResult | undefined> => {
    if (!org || !session?.user?.id) {
      toast.error("Not authenticated");
      return undefined;
    }

    const { item: registryItem } = await studio.call(
      "COLLECTION_REGISTRY_APP_GET",
      { name: bindingType },
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
