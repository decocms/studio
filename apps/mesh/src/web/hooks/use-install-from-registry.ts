/**
 * Hook to install an MCP Server from the registry catalog by binding type.
 * Provides inline installation without navigation.
 *
 * Resolves the catalog item over REST (`GET /api/registry/items/:id`) and turns
 * it into a connection via `extractConnectionData` (unchanged).
 */

import { toast } from "sonner";
import type { RegistryItem } from "@/web/components/store/types";
import { authClient } from "@/web/lib/auth-client";
import {
  useConnectionActions,
  useProjectContext,
  type ConnectionEntity,
} from "@decocms/mesh-sdk";
import { extractConnectionData } from "@/web/utils/extract-connection-data";

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
 * Normalize an MCP Server identifier into the catalog item id.
 * Catalog ids are `<scope>/<name>` (no leading `@`); binding types arrive as
 * `@deco/database` or `deco/database`, so we strip a leading `@`.
 */
function toCatalogIdentifier(bindingType: string): string {
  return bindingType.replace(/^@/, "");
}

async function fetchCatalogItem(
  identifier: string,
): Promise<RegistryItem | null> {
  const res = await fetch(
    `/api/registry/items/${encodeURIComponent(identifier)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Failed to resolve registry item: ${res.status}`);
  }
  const data = (await res.json()) as { item?: RegistryItem };
  return data.item ?? null;
}

/**
 * Hook that provides inline MCP Server installation from the registry catalog.
 * Use this when you want to install a specific MCP Server without navigating away.
 */
export function useInstallFromRegistry(): UseInstallFromRegistryResult {
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const actions = useConnectionActions();

  const installByBinding = async (
    bindingType: string,
  ): Promise<InstallResult | undefined> => {
    if (!org || !session?.user?.id) {
      toast.error("Not authenticated");
      return undefined;
    }

    let registryItem: RegistryItem | null;
    try {
      registryItem = await fetchCatalogItem(toCatalogIdentifier(bindingType));
    } catch {
      toast.error("Failed to reach the registry");
      return undefined;
    }

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
