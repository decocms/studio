/**
 * Project Plugin Configs Storage
 *
 * Storage layer for per-project plugin configurations.
 * Each config can optionally bind to an MCP connection.
 */

import type { Kysely } from "kysely";
import type { Database, ProjectPluginConfig } from "./types";
import type { ProjectPluginConfigStoragePort } from "./ports";
import { generatePrefixedId } from "@/shared/utils/generate-id";

/**
 * Summary of a bound connection for display purposes
 */
export interface BoundConnectionSummary {
  id: string;
  title: string;
  icon: string | null;
}

export class ProjectPluginConfigsStorage
  implements ProjectPluginConfigStoragePort
{
  constructor(private readonly db: Kysely<Database>) {}

  private parseRow(row: {
    id: string;
    project_id: string;
    plugin_id: string;
    connection_id: string | null;
    settings: string | Record<string, unknown> | null;
    created_at: Date | string;
    updated_at: Date | string;
  }): ProjectPluginConfig {
    return {
      id: row.id,
      projectId: row.project_id,
      pluginId: row.plugin_id,
      connectionId: row.connection_id,
      settings: row.settings
        ? typeof row.settings === "string"
          ? JSON.parse(row.settings)
          : row.settings
        : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async list(projectId: string): Promise<ProjectPluginConfig[]> {
    const rows = await this.db
      .selectFrom("project_plugin_configs")
      .selectAll()
      .where("project_id", "=", projectId)
      .execute();
    return rows.map((row) => this.parseRow(row));
  }

  async get(
    projectId: string,
    pluginId: string,
    organizationId: string,
  ): Promise<ProjectPluginConfig | null> {
    let query = this.db
      .selectFrom("project_plugin_configs")
      .selectAll("project_plugin_configs")
      .where("project_plugin_configs.project_id", "=", projectId)
      .where("project_plugin_configs.plugin_id", "=", pluginId);

    if (organizationId) {
      query = query
        .innerJoin(
          "projects",
          "projects.id",
          "project_plugin_configs.project_id",
        )
        .where("projects.organization_id", "=", organizationId);
    }

    const row = await query.executeTakeFirst();
    return row ? this.parseRow(row) : null;
  }

  async upsert(
    projectId: string,
    pluginId: string,
    data: {
      connectionId?: string | null;
      settings?: Record<string, unknown> | null;
    },
    organizationId: string,
  ): Promise<ProjectPluginConfig> {
    const now = new Date().toISOString();
    const existing = await this.get(projectId, pluginId, organizationId);

    if (existing) {
      const updateData: Record<string, unknown> = { updated_at: now };
      if (data.connectionId !== undefined)
        updateData.connection_id = data.connectionId;
      if (data.settings !== undefined) {
        updateData.settings = data.settings
          ? JSON.stringify(data.settings)
          : null;
      }

      await this.db
        .updateTable("project_plugin_configs")
        .set(updateData)
        .where("project_id", "=", projectId)
        .where("plugin_id", "=", pluginId)
        .execute();

      const updated = await this.get(projectId, pluginId, organizationId);
      if (!updated) {
        throw new Error("Failed to update project plugin config");
      }
      return updated;
    }

    const id = generatePrefixedId("ppc");
    await this.db
      .insertInto("project_plugin_configs")
      .values({
        id,
        project_id: projectId,
        plugin_id: pluginId,
        connection_id: data.connectionId ?? null,
        settings: data.settings ? JSON.stringify(data.settings) : null,
        created_at: now,
        updated_at: now,
      })
      .execute();

    const created = await this.get(projectId, pluginId, organizationId);
    if (!created) {
      throw new Error("Failed to create project plugin config");
    }
    return created;
  }

  async delete(projectId: string, pluginId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("project_plugin_configs")
      .where("project_id", "=", projectId)
      .where("plugin_id", "=", pluginId)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }

  /**
   * Get bound connections for multiple projects (for list display)
   * Returns a map of project ID to array of connection summaries
   */
  async getBoundConnectionsForProjects(
    projectIds: string[],
  ): Promise<Map<string, BoundConnectionSummary[]>> {
    if (projectIds.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .selectFrom("project_plugin_configs")
      .innerJoin(
        "connections",
        "connections.id",
        "project_plugin_configs.connection_id",
      )
      .select([
        "project_plugin_configs.project_id",
        "connections.id as connection_id",
        "connections.title",
        "connections.icon",
      ])
      .where("project_plugin_configs.project_id", "in", projectIds)
      .where("project_plugin_configs.connection_id", "is not", null)
      .execute();

    const result = new Map<string, BoundConnectionSummary[]>();

    for (const row of rows) {
      const projectId = row.project_id;
      if (!result.has(projectId)) {
        result.set(projectId, []);
      }
      result.get(projectId)!.push({
        id: row.connection_id,
        title: row.title,
        icon: row.icon,
      });
    }

    return result;
  }
}
