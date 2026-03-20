/**
 * Virtual MCP Plugin Configs Storage
 *
 * Storage layer for per-virtual-MCP plugin configurations.
 * Each config can optionally bind to an MCP connection.
 */

import type { Kysely } from "kysely";
import type { Database } from "./types";
import type {
  VirtualMcpPluginConfig,
  VirtualMcpPluginConfigStoragePort,
  BoundConnectionSummary,
} from "./ports";
import { generatePrefixedId } from "@/shared/utils/generate-id";

export class VirtualMcpPluginConfigsStorage
  implements VirtualMcpPluginConfigStoragePort
{
  constructor(private readonly db: Kysely<Database>) {}

  private parseRow(row: {
    id: string;
    virtual_mcp_id: string;
    plugin_id: string;
    connection_id: string | null;
    settings: string | Record<string, unknown> | null;
    created_at: Date | string;
    updated_at: Date | string;
  }): VirtualMcpPluginConfig {
    return {
      id: row.id,
      virtualMcpId: row.virtual_mcp_id,
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

  async list(virtualMcpId: string): Promise<VirtualMcpPluginConfig[]> {
    const rows = await this.db
      .selectFrom("virtual_mcp_plugin_configs")
      .selectAll()
      .where("virtual_mcp_id", "=", virtualMcpId)
      .execute();
    return rows.map((row) => this.parseRow(row));
  }

  async get(
    virtualMcpId: string,
    pluginId: string,
  ): Promise<VirtualMcpPluginConfig | null> {
    const row = await this.db
      .selectFrom("virtual_mcp_plugin_configs")
      .selectAll()
      .where("virtual_mcp_id", "=", virtualMcpId)
      .where("plugin_id", "=", pluginId)
      .executeTakeFirst();
    return row ? this.parseRow(row) : null;
  }

  async upsert(
    virtualMcpId: string,
    pluginId: string,
    data: {
      connectionId?: string | null;
      settings?: Record<string, unknown> | null;
    },
  ): Promise<VirtualMcpPluginConfig> {
    const now = new Date().toISOString();
    const existing = await this.get(virtualMcpId, pluginId);

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
        .updateTable("virtual_mcp_plugin_configs")
        .set(updateData)
        .where("virtual_mcp_id", "=", virtualMcpId)
        .where("plugin_id", "=", pluginId)
        .execute();

      const updated = await this.get(virtualMcpId, pluginId);
      if (!updated) {
        throw new Error("Failed to update virtual MCP plugin config");
      }
      return updated;
    }

    const id = generatePrefixedId("vpc");
    await this.db
      .insertInto("virtual_mcp_plugin_configs")
      .values({
        id,
        virtual_mcp_id: virtualMcpId,
        plugin_id: pluginId,
        connection_id: data.connectionId ?? null,
        settings: data.settings ? JSON.stringify(data.settings) : null,
        created_at: now,
        updated_at: now,
      })
      .execute();

    const created = await this.get(virtualMcpId, pluginId);
    if (!created) {
      throw new Error("Failed to create virtual MCP plugin config");
    }
    return created;
  }

  async delete(virtualMcpId: string, pluginId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("virtual_mcp_plugin_configs")
      .where("virtual_mcp_id", "=", virtualMcpId)
      .where("plugin_id", "=", pluginId)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }

  /**
   * Get bound connections for multiple virtual MCPs (for list display)
   * Returns a map of virtual MCP ID to array of connection summaries
   */
  async getBoundConnectionsForVirtualMcps(
    virtualMcpIds: string[],
  ): Promise<Map<string, BoundConnectionSummary[]>> {
    if (virtualMcpIds.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .selectFrom("virtual_mcp_plugin_configs")
      .innerJoin(
        "connections",
        "connections.id",
        "virtual_mcp_plugin_configs.connection_id",
      )
      .select([
        "virtual_mcp_plugin_configs.virtual_mcp_id",
        "connections.id as connection_id",
        "connections.title",
        "connections.icon",
      ])
      .where("virtual_mcp_plugin_configs.virtual_mcp_id", "in", virtualMcpIds)
      .where("virtual_mcp_plugin_configs.connection_id", "is not", null)
      .execute();

    const result = new Map<string, BoundConnectionSummary[]>();

    for (const row of rows) {
      const virtualMcpId = row.virtual_mcp_id;
      if (!result.has(virtualMcpId)) {
        result.set(virtualMcpId, []);
      }
      result.get(virtualMcpId)!.push({
        id: row.connection_id,
        title: row.title,
        icon: row.icon,
      });
    }

    return result;
  }
}
