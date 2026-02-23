import type {
  ServerPluginToolContext,
  ServerPluginToolDefinition,
} from "@decocms/bindings/server-plugin";
import type { z } from "zod";
import { PLUGIN_ID } from "../../shared";
import type { PrivateRegistryPluginStorage } from "../storage";

let pluginStorage: PrivateRegistryPluginStorage | null = null;

export function setPluginStorage(storage: PrivateRegistryPluginStorage): void {
  pluginStorage = storage;
}

export function getPluginStorage(): PrivateRegistryPluginStorage {
  if (!pluginStorage) {
    throw new Error(
      `Plugin storage not initialized. Make sure the "${PLUGIN_ID}" plugin is enabled.`,
    );
  }
  return pluginStorage;
}

/** Context returned by requireOrgContext — organization is guaranteed non-null. */
export type OrgToolContext = ServerPluginToolContext & {
  organization: { id: string };
};

async function requireOrgContext(
  ctx: ServerPluginToolContext,
): Promise<OrgToolContext> {
  if (!ctx.organization) {
    throw new Error("Organization context required");
  }
  await ctx.access.check();
  return ctx as OrgToolContext;
}

/** Creates a typed handler that validates org context and casts input automatically. */
export function orgHandler<T extends z.ZodType>(
  _schema: T,
  fn: (input: z.infer<T>, ctx: OrgToolContext) => Promise<unknown>,
): ServerPluginToolDefinition["handler"] {
  return async (input, ctx) => {
    const orgCtx = await requireOrgContext(ctx);
    return fn(input as z.infer<T>, orgCtx);
  };
}

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
  ctx: ServerPluginToolContext,
  organizationId: string,
): Promise<PrivateRegistryPluginSettings> {
  const rows = await (ctx.db as any)
    .selectFrom("project_plugin_configs")
    .innerJoin("projects", "projects.id", "project_plugin_configs.project_id")
    .select(["project_plugin_configs.settings as settings"])
    .where("projects.organization_id", "=", organizationId)
    .where("project_plugin_configs.plugin_id", "=", PLUGIN_ID)
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
