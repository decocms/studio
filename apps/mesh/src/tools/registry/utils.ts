import type { MeshContext } from "@/core/mesh-context";
import { PLUGIN_ID } from "./shared";

export interface PrivateRegistryPluginSettings {
  acceptPublishRequests?: boolean;
  requireApiToken?: boolean;
  storePrivateOnly?: boolean;
}

function parsePluginSettings(raw: unknown): PrivateRegistryPluginSettings {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return parsed as PrivateRegistryPluginSettings;
    } catch {
      return {};
    }
  }
  if (typeof raw === "object") {
    return raw as PrivateRegistryPluginSettings;
  }
  return {};
}

export async function getRegistryPluginSettings(
  ctx: MeshContext,
  organizationId: string,
): Promise<PrivateRegistryPluginSettings> {
  const rows = await (ctx.db as any)
    .selectFrom("virtual_mcp_plugin_configs")
    .innerJoin(
      "connections",
      "connections.id",
      "virtual_mcp_plugin_configs.virtual_mcp_id",
    )
    .select(["virtual_mcp_plugin_configs.settings as settings"])
    .where("connections.organization_id", "=", organizationId)
    .where("connections.subtype", "=", "project")
    .where("virtual_mcp_plugin_configs.plugin_id", "=", PLUGIN_ID)
    .execute();

  const parsedSettings = (rows as Array<{ settings: unknown }>).map((row) =>
    parsePluginSettings(row.settings),
  );

  // Plugin settings are persisted per-project. For org-wide Store behavior, we
  // treat booleans as enabled when any project has them enabled.
  const merged: PrivateRegistryPluginSettings = {
    acceptPublishRequests: parsedSettings.some(
      (settings) => settings.acceptPublishRequests === true,
    ),
    requireApiToken: parsedSettings.some(
      (settings) => settings.requireApiToken === true,
    ),
    storePrivateOnly: parsedSettings.some(
      (settings) => settings.storePrivateOnly === true,
    ),
  };

  if (
    merged.acceptPublishRequests ||
    merged.requireApiToken ||
    merged.storePrivateOnly
  ) {
    return merged;
  }

  for (const settings of parsedSettings) {
    if (Object.keys(settings).length > 0) {
      return settings;
    }
  }

  return {};
}
