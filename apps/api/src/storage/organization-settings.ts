import { sql, type Kysely } from "kysely";
import type { Database, OrganizationSettings } from "./types";
import type { OrganizationSettingsStoragePort } from "./ports";

/**
 * Atomic two-level merge for `repo_flags`: repos absent from the write keep
 * their stored entry, and a written repo's entry merges key-by-key so setting
 * one toggle never clears that repo's other two.
 *
 * The org-level `flags || $new` concat can't do this — at the top level it would
 * REPLACE a repo's whole entry. The repo keys are known here (they come from the
 * caller's write), so the expression is built per key rather than in a
 * correlated subquery over `jsonb_each`.
 */
function mergeRepoFlagsSql(repoFlags: Record<string, unknown>) {
  const entries = Object.entries(repoFlags);
  if (entries.length === 0) {
    return sql<string>`coalesce("organization_settings"."repo_flags", '{}'::jsonb)`;
  }
  const merged = entries.map(
    ([repo, flags]) =>
      sql`${repo}::text, coalesce("organization_settings"."repo_flags" -> ${repo}, '{}'::jsonb) || ${JSON.stringify(flags)}::jsonb`,
  );
  return sql<string>`coalesce("organization_settings"."repo_flags", '{}'::jsonb) || jsonb_build_object(${sql.join(merged, sql`, `)})`;
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
      flags: record.flags
        ? typeof record.flags === "string"
          ? JSON.parse(record.flags)
          : record.flags
        : null,
      repo_flags: record.repo_flags
        ? typeof record.repo_flags === "string"
          ? JSON.parse(record.repo_flags)
          : record.repo_flags
        : null,
      main_agent_id: record.main_agent_id ?? null,
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
        | "repo_flags"
        | "main_agent_id"
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
    const flagsJson = data?.flags ? JSON.stringify(data.flags) : null;
    const repoFlagsJson = data?.repo_flags
      ? JSON.stringify(data.repo_flags)
      : null;
    const repoFlagsMerge = data?.repo_flags
      ? mergeRepoFlagsSql(data.repo_flags)
      : undefined;
    await this.db
      .insertInto("organization_settings")
      .values({
        organizationId,
        sidebar_items: sidebarItemsJson,
        enabled_plugins: enabledPluginsJson,
        registry_config: registryConfigJson,
        simple_mode: simpleModeJson,
        default_home_agents: defaultHomeAgentsJson,
        flags: flagsJson,
        repo_flags: repoFlagsJson,
        main_agent_id: data?.main_agent_id ?? null,
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
          // Flags shallow-merge atomically: keys in the update win, omitted
          // keys keep their stored value (explicit `false` persists — merge,
          // not spread-and-replace). Absent field skips the column.
          flags: flagsJson
            ? sql<string>`coalesce("organization_settings"."flags", '{}'::jsonb) || ${flagsJson}::jsonb`
            : undefined,
          // Per-repo overrides merge one level DEEPER — see mergeRepoFlagsSql.
          repo_flags: repoFlagsMerge,
          // Nullable id: explicit `null` clears the main agent; `undefined`
          // (field absent) skips the column so partial updates don't wipe it.
          main_agent_id: data?.main_agent_id,
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
        repo_flags: data?.repo_flags ?? null,
        main_agent_id: data?.main_agent_id ?? null,
        createdAt: now,
        updatedAt: now,
      };
    }

    return settings;
  }
}
