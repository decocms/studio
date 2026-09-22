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

/** Map a raw `organization_settings` row (from a select or a RETURNING clause) to the parsed shape. */
function mapRecord(record: {
  organizationId: string;
  sidebar_items: unknown;
  coding_agent_mcp_excluded: unknown;
  simple_mode: unknown;
  default_home_agents: unknown;
  flags: unknown;
  submodule_credentials: unknown;
  createdAt: OrganizationSettings["createdAt"];
  updatedAt: OrganizationSettings["updatedAt"];
}): OrganizationSettings {
  return {
    organizationId: record.organizationId,
    sidebar_items: parseJsonColumn<OrganizationSettings["sidebar_items"]>(
      record.sidebar_items,
    ),
    coding_agent_mcp_excluded: parseJsonColumn<
      OrganizationSettings["coding_agent_mcp_excluded"]
    >(record.coding_agent_mcp_excluded),
    simple_mode: parseJsonColumn<OrganizationSettings["simple_mode"]>(
      record.simple_mode,
    ),
    default_home_agents: parseJsonColumn<
      OrganizationSettings["default_home_agents"]
    >(record.default_home_agents),
    flags: parseJsonColumn<OrganizationSettings["flags"]>(record.flags),
    submodule_credentials: parseJsonColumn<
      OrganizationSettings["submodule_credentials"]
    >(record.submodule_credentials),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
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

    return record ? mapRecord(record) : null;
  }

  async upsert(
    organizationId: string,
    data?: Partial<
      Pick<
        OrganizationSettings,
        | "sidebar_items"
        | "coding_agent_mcp_excluded"
        | "simple_mode"
        | "default_home_agents"
        | "flags"
        | "submodule_credentials"
      >
    >,
  ): Promise<OrganizationSettings> {
    const now = new Date().toISOString();
    const json = {
      sidebar_items: toJsonColumn(data?.sidebar_items),
      coding_agent_mcp_excluded: toJsonColumn(data?.coding_agent_mcp_excluded),
      simple_mode: toJsonColumn(data?.simple_mode),
      default_home_agents: toJsonColumn(data?.default_home_agents),
      flags: toJsonColumn(data?.flags),
      submodule_credentials: toJsonColumn(data?.submodule_credentials),
    };
    // RETURNING the write itself, instead of a follow-up SELECT, so a concurrent upsert can't make this call return someone else's write.
    const record = await this.db
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
          coding_agent_mcp_excluded:
            json.coding_agent_mcp_excluded ?? undefined,
          simple_mode: json.simple_mode ?? undefined,
          default_home_agents: json.default_home_agents ?? undefined,
          // Flags shallow-merge atomically: keys in the update win, omitted
          // keys keep their stored value (explicit `false` persists — merge,
          // not spread-and-replace). Absent field skips the column.
          flags: json.flags
            ? sql<string>`coalesce("organization_settings"."flags", '{}'::jsonb) || ${json.flags}::jsonb`
            : undefined,
          submodule_credentials: json.submodule_credentials ?? undefined,
          updatedAt: now,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapRecord(record);
  }
}
