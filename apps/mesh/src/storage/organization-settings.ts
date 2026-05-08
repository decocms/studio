import type { Kysely } from "kysely";
import type { Database, OrganizationSettings } from "./types";
import type { OrganizationSettingsStoragePort } from "./ports";

export class OrganizationSettingsStorage
  implements OrganizationSettingsStoragePort
{
  constructor(private readonly db: Kysely<Database>) {}

  async get(organizationId: string): Promise<OrganizationSettings | null> {
    const record = await this.db
      .selectFrom("organization_settings")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .executeTakeFirst();

    if (!record) {
      return null;
    }

    return {
      organizationId: record.organizationId,
      sidebar_items: record.sidebar_items
        ? typeof record.sidebar_items === "string"
          ? JSON.parse(record.sidebar_items)
          : record.sidebar_items
        : null,
      enabled_plugins: record.enabled_plugins
        ? typeof record.enabled_plugins === "string"
          ? JSON.parse(record.enabled_plugins)
          : record.enabled_plugins
        : null,
      registry_config: record.registry_config
        ? typeof record.registry_config === "string"
          ? JSON.parse(record.registry_config)
          : record.registry_config
        : null,
      simple_mode: record.simple_mode
        ? typeof record.simple_mode === "string"
          ? JSON.parse(record.simple_mode)
          : record.simple_mode
        : null,
      default_home_agents: record.default_home_agents
        ? typeof record.default_home_agents === "string"
          ? JSON.parse(record.default_home_agents)
          : record.default_home_agents
        : null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  async upsert(
    organizationId: string,
    data?: Partial<
      Pick<
        OrganizationSettings,
        | "sidebar_items"
        | "enabled_plugins"
        | "registry_config"
        | "simple_mode"
        | "default_home_agents"
      >
    >,
  ): Promise<OrganizationSettings> {
    const now = new Date().toISOString();
    const sidebarItemsJson = data?.sidebar_items
      ? JSON.stringify(data.sidebar_items)
      : null;
    const enabledPluginsJson = data?.enabled_plugins
      ? JSON.stringify(data.enabled_plugins)
      : null;
    const registryConfigJson = data?.registry_config
      ? JSON.stringify(data.registry_config)
      : null;
    const simpleModeJson = data?.simple_mode
      ? JSON.stringify(data.simple_mode)
      : null;
    const defaultHomeAgentsJson = data?.default_home_agents
      ? JSON.stringify(data.default_home_agents)
      : null;

    await this.db
      .insertInto("organization_settings")
      .values({
        organizationId,
        sidebar_items: sidebarItemsJson,
        enabled_plugins: enabledPluginsJson,
        registry_config: registryConfigJson,
        simple_mode: simpleModeJson,
        default_home_agents: defaultHomeAgentsJson,
        createdAt: now,
        updatedAt: now,
      })
      .onConflict((oc) =>
        oc.column("organizationId").doUpdateSet({
          sidebar_items: sidebarItemsJson ? sidebarItemsJson : undefined,
          enabled_plugins: enabledPluginsJson ? enabledPluginsJson : undefined,
          registry_config: registryConfigJson ? registryConfigJson : undefined,
          simple_mode: simpleModeJson ? simpleModeJson : undefined,
          default_home_agents: defaultHomeAgentsJson
            ? defaultHomeAgentsJson
            : undefined,
          updatedAt: now,
        }),
      )
      .execute();

    const settings = await this.get(organizationId);
    if (!settings) {
      // Should not happen, but return synthesized value in case of race conditions
      return {
        organizationId,
        sidebar_items: data?.sidebar_items ?? null,
        enabled_plugins: data?.enabled_plugins ?? null,
        registry_config: data?.registry_config ?? null,
        simple_mode: data?.simple_mode ?? null,
        default_home_agents: data?.default_home_agents ?? null,
        createdAt: now,
        updatedAt: now,
      };
    }

    return settings;
  }
}
