import { useRegistryConnections } from "@/web/hooks/use-registry-connections";
import { useRegistrySettings } from "@/web/hooks/use-registry-settings";
import { type RegistrySource } from "@/web/hooks/use-merged-store-discovery";
import { SELF_MCP_ALIAS_ID, useProjectContext } from "@decocms/mesh-sdk";

/**
 * Returns the list of enabled registry sources based on org settings,
 * including the private registry when the plugin is active.
 */
export function useEnabledRegistries(): RegistrySource[] {
  const registryConnections = useRegistryConnections();
  const { isRegistryEnabled } = useRegistrySettings();
  const enabledPlugins = useProjectContext().project.enabledPlugins ?? [];

  const enabledRegistries: RegistrySource[] = registryConnections
    .filter((c) => isRegistryEnabled(c.id))
    .map((c) => ({ id: c.id, title: c.title, icon: c.icon }));

  if (
    enabledPlugins.includes("private-registry") &&
    isRegistryEnabled(SELF_MCP_ALIAS_ID)
  ) {
    enabledRegistries.push({
      id: SELF_MCP_ALIAS_ID,
      title: "Private Registry",
      icon: null,
    });
  }

  return enabledRegistries;
}
