import { sql, type Kysely } from "kysely";
import type { Database, OrganizationSettings } from "./types";
import type { OrganizationSettingsStoragePort } from "./ports";

/**
 * jsonb columns come back as an already-parsed object from some drivers and
 * as a raw JSON string from others — normalize both to the parsed shape.
 */
function parseJsonColumn<T>(value: unknown): T | null {
  if (!value) return null;
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

/** Stringify a JSON column's write value, or null when it's absent/empty. */
function toJsonColumn(value: unknown): string | null {
  return value ? JSON.stringify(value) : null;
}

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
      sidebar_items: parseJsonColumn<OrganizationSettings["sidebar_items"]>(
        record.sidebar_items,
      ),
      enabled_plugins: parseJsonColumn<OrganizationSettings["enabled_plugins"]>(
        record.enabled_plugins,
      ),
      registry_config: parseJsonColumn<OrganizationSettings["registry_config"]>(
        record.registry_config,
      ),
      simple_mode: parseJsonColumn<OrganizationSettings["simple_mode"]>(
        record.simple_mode,
      ),
      default_home_agents: parseJsonColumn<
        OrganizationSettings["default_home_agents"]
      >(record.default_home_agents),
      flags: parseJsonColumn<OrganizationSettings["flags"]>(record.flags),
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
        | "flags"
      >
    >,
  ): Promise<OrganizationSettings> {
    const now = new Date().toISOString();
    const json = {
      sidebar_items: toJsonColumn(data?.sidebar_items),
      enabled_plugins: toJsonColumn(data?.enabled_plugins),
      registry_config: toJsonColumn(data?.registry_config),
      simple_mode: toJsonColumn(data?.simple_mode),
      default_home_agents: toJsonColumn(data?.default_home_agents),
      flags: toJsonColumn(data?.flags),
    };
    await this.db
      .insertInto("organization_settings")
      .values({
        organizationId,
        ...json,
        createdAt: now,
        updatedAt: now,
      })
      .onConflict((oc) =>
        oc.column("organizationId").doUpdateSet({
          sidebar_items: json.sidebar_items ?? undefined,
          enabled_plugins: json.enabled_plugins ?? undefined,
          registry_config: json.registry_config ?? undefined,
          simple_mode: json.simple_mode ?? undefined,
          default_home_agents: json.default_home_agents ?? undefined,
          // Flags shallow-merge atomically: keys in the update win, omitted
          // keys keep their stored value (explicit `false` persists — merge,
          // not spread-and-replace). Absent field skips the column.
          flags: json.flags
            ? sql<string>`coalesce("organization_settings"."flags", '{}'::jsonb) || ${json.flags}::jsonb`
            : undefined,
          // Nullable id: explicit `null` clears the main agent; `undefined`
          // (field absent) skips the column so partial updates don't wipe it.
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
        flags: data?.flags ?? null,
        createdAt: now,
        updatedAt: now,
      };
    }

    return settings;
  }
}
