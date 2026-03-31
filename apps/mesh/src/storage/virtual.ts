/**
 * Virtual MCP Storage Implementation
 *
 * This is now a FACADE over the connections table.
 * Virtual MCPs are stored as connections with connection_type = 'VIRTUAL'.
 * The aggregations (which child connections are included) are stored in
 * the connection_aggregations table.
 *
 * The aggregations (which child connections are included) are stored in
 * the connection_aggregations table.
 */

import type { Kysely } from "kysely";
import { generatePrefixedId } from "@/shared/utils/generate-id";
import {
  getWellKnownDecopilotVirtualMCP,
  isDecopilot,
} from "@decocms/mesh-sdk";
import type {
  VirtualMCPCreateData,
  VirtualMCPEntity,
  VirtualMCPStoragePort,
  VirtualMCPUpdateData,
} from "./ports";
import type { Database, DependencyMode } from "./types";

/** Raw database row type for connections (VIRTUAL type) */
type RawConnectionRow = {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  icon: string | null;
  status: "active" | "inactive" | "error";
  pinned: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  created_by: string;
  updated_by: string | null;
  metadata: string | null;
};

/** Raw database row type for connection_aggregations */
type RawAggregationRow = {
  id: string;
  parent_connection_id: string;
  child_connection_id: string;
  selected_tools: string | string[] | null;
  selected_resources: string | string[] | null;
  selected_prompts: string | string[] | null;
  dependency_mode: DependencyMode;
  created_at: Date | string;
};

export class VirtualMCPStorage implements VirtualMCPStoragePort {
  constructor(private db: Kysely<Database>) {}

  async create(
    organizationId: string,
    userId: string,
    data: VirtualMCPCreateData,
  ): Promise<VirtualMCPEntity> {
    const id = generatePrefixedId("vir");
    const now = new Date().toISOString();

    // Insert as a VIRTUAL connection
    await this.db
      .insertInto("connections")
      .values({
        id,
        organization_id: organizationId,
        created_by: userId,
        title: data.title,
        description: data.description ?? null,
        icon: data.icon ?? null,
        app_name: null,
        app_id: null,
        connection_type: "VIRTUAL",
        pinned: data.pinned ?? false,
        connection_url: `virtual://${id}`,
        connection_token: null,
        connection_headers: null,
        oauth_config: null,
        configuration_state: null,
        configuration_scopes: null,
        metadata: data.metadata ? JSON.stringify(data.metadata) : null,
        bindings: null,
        status: data.status ?? "active",
        created_at: now,
        updated_at: now,
      })
      .execute();

    // Insert connection aggregations (all explicit connections are 'direct' dependencies)
    if (data.connections.length > 0) {
      await this.db
        .insertInto("connection_aggregations")
        .values(
          data.connections.map((conn) => ({
            id: generatePrefixedId("agg"),
            parent_connection_id: id,
            child_connection_id: conn.connection_id,
            selected_tools: conn.selected_tools
              ? JSON.stringify(conn.selected_tools)
              : null,
            selected_resources: conn.selected_resources
              ? JSON.stringify(conn.selected_resources)
              : null,
            selected_prompts: conn.selected_prompts
              ? JSON.stringify(conn.selected_prompts)
              : null,
            dependency_mode: "direct" as DependencyMode,
            created_at: now,
          })),
        )
        .execute();
    }

    const virtualMcp = await this.findById(id);
    if (!virtualMcp) {
      throw new Error(`Failed to create virtual MCP with id: ${id}`);
    }

    return virtualMcp;
  }

  async findById(
    id: string,
    organizationId?: string,
  ): Promise<VirtualMCPEntity | null> {
    // Handle Decopilot ID - return Decopilot agent with all org connections
    const decopilotOrgId = isDecopilot(id);
    if (decopilotOrgId) {
      const resolvedOrgId = organizationId ?? decopilotOrgId;

      // Get all active connections for the organization
      const connections = await this.db
        .selectFrom("connections")
        .selectAll()
        .where("organization_id", "=", resolvedOrgId)
        .where("status", "!=", "inactive")
        .where("status", "!=", "error")
        .execute();

      // Return Decopilot agent with connections populated
      return {
        ...getWellKnownDecopilotVirtualMCP(resolvedOrgId),
        pinned: false,
        connections: connections.map((c) => ({
          connection_id: c.id,
          selected_tools: null, // null = all tools
          selected_resources: null, // null = all resources
          selected_prompts: null, // null = all prompts
        })),
      };
    }

    // Normal database lookup for string IDs
    return this.findByIdInternal(this.db, id);
  }

  private async findByIdInternal(
    db: Kysely<Database>,
    id: string,
  ): Promise<VirtualMCPEntity | null> {
    const row = await db
      .selectFrom("connections")
      .selectAll()
      .where("id", "=", id)
      .where("connection_type", "=", "VIRTUAL")
      .executeTakeFirst();

    if (!row) {
      return null;
    }

    // Only fetch 'direct' dependencies - indirect deps are not exposed in the entity
    const aggregationRows = await db
      .selectFrom("connection_aggregations")
      .selectAll()
      .where("parent_connection_id", "=", id)
      .where("dependency_mode", "=", "direct")
      .execute();

    return this.deserializeVirtualMCPEntity(
      row as unknown as RawConnectionRow,
      aggregationRows as RawAggregationRow[],
    );
  }

  async list(
    organizationId: string,
    options?: { pinnedOnly?: boolean },
  ): Promise<VirtualMCPEntity[]> {
    let query = this.db
      .selectFrom("connections")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("connection_type", "=", "VIRTUAL");

    if (options?.pinnedOnly) {
      query = query.where("pinned", "=", true);
    }

    const rows = await query.execute();

    const virtualMcpIds = rows.map((r) => r.id);

    if (virtualMcpIds.length === 0) {
      return [];
    }

    // Fetch only 'direct' aggregations for all virtual MCPs in one query
    const aggregationRows = await this.db
      .selectFrom("connection_aggregations")
      .selectAll()
      .where("parent_connection_id", "in", virtualMcpIds)
      .where("dependency_mode", "=", "direct")
      .execute();

    // Group aggregations by parent_connection_id
    const aggregationsByParent = new Map<string, RawAggregationRow[]>();
    for (const agg of aggregationRows as RawAggregationRow[]) {
      const existing = aggregationsByParent.get(agg.parent_connection_id) ?? [];
      existing.push(agg);
      aggregationsByParent.set(agg.parent_connection_id, existing);
    }

    return rows.map((row) =>
      this.deserializeVirtualMCPEntity(
        row as unknown as RawConnectionRow,
        aggregationsByParent.get(row.id) ?? [],
      ),
    );
  }

  async listByConnectionId(
    organizationId: string,
    connectionId: string,
  ): Promise<VirtualMCPEntity[]> {
    // Find virtual MCP IDs that include this connection as a child (any dependency mode)
    const aggregationRows = await this.db
      .selectFrom("connection_aggregations")
      .select("parent_connection_id")
      .where("child_connection_id", "=", connectionId)
      .execute();

    const virtualMcpIds = aggregationRows.map((r) => r.parent_connection_id);

    if (virtualMcpIds.length === 0) {
      return [];
    }

    // Fetch the virtual MCPs (filtered by organization and VIRTUAL type)
    const rows = await this.db
      .selectFrom("connections")
      .selectAll()
      .where("id", "in", virtualMcpIds)
      .where("organization_id", "=", organizationId)
      .where("connection_type", "=", "VIRTUAL")
      .execute();

    if (rows.length === 0) {
      return [];
    }

    const resultVirtualMcpIds = rows.map((r) => r.id);

    // Fetch only 'direct' aggregations for these virtual MCPs
    const allAggregationRows = await this.db
      .selectFrom("connection_aggregations")
      .selectAll()
      .where("parent_connection_id", "in", resultVirtualMcpIds)
      .where("dependency_mode", "=", "direct")
      .execute();

    // Group aggregations by parent_connection_id
    const aggregationsByParent = new Map<string, RawAggregationRow[]>();
    for (const agg of allAggregationRows as RawAggregationRow[]) {
      const existing = aggregationsByParent.get(agg.parent_connection_id) ?? [];
      existing.push(agg);
      aggregationsByParent.set(agg.parent_connection_id, existing);
    }

    return rows.map((row) =>
      this.deserializeVirtualMCPEntity(
        row as RawConnectionRow,
        aggregationsByParent.get(row.id) ?? [],
      ),
    );
  }

  async update(
    id: string,
    userId: string,
    data: VirtualMCPUpdateData,
  ): Promise<VirtualMCPEntity> {
    const now = new Date().toISOString();

    // Build update object for connections table
    const updateData: Record<string, unknown> = {
      updated_at: now,
      updated_by: userId,
    };

    if (data.title !== undefined) {
      updateData.title = data.title;
    }
    if (data.description !== undefined) {
      updateData.description = data.description;
    }
    if (data.icon !== undefined) {
      updateData.icon = data.icon;
    }
    if (data.status !== undefined) {
      updateData.status = data.status;
    }
    if (data.pinned !== undefined) {
      updateData.pinned = data.pinned;
    }
    if (data.metadata !== undefined) {
      updateData.metadata = data.metadata
        ? JSON.stringify(data.metadata)
        : null;
    }

    // Update the connection
    await this.db
      .updateTable("connections")
      .set(updateData)
      .where("id", "=", id)
      .where("connection_type", "=", "VIRTUAL")
      .execute();

    // Update aggregations if provided
    if (data.connections !== undefined) {
      // Collect current direct connection IDs before removing them
      const currentAggs = await this.db
        .selectFrom("connection_aggregations")
        .select("child_connection_id")
        .where("parent_connection_id", "=", id)
        .where("dependency_mode", "=", "direct")
        .execute();
      const previousIds = new Set(
        currentAggs.map((a) => a.child_connection_id),
      );

      // Only delete 'direct' dependencies - preserve 'indirect' ones from virtual tools
      await this.db
        .deleteFrom("connection_aggregations")
        .where("parent_connection_id", "=", id)
        .where("dependency_mode", "=", "direct")
        .execute();

      if (data.connections.length > 0) {
        await this.db
          .insertInto("connection_aggregations")
          .values(
            data.connections.map((conn) => ({
              id: generatePrefixedId("agg"),
              parent_connection_id: id,
              child_connection_id: conn.connection_id,
              selected_tools: conn.selected_tools
                ? JSON.stringify(conn.selected_tools)
                : null,
              selected_resources: conn.selected_resources
                ? JSON.stringify(conn.selected_resources)
                : null,
              selected_prompts: conn.selected_prompts
                ? JSON.stringify(conn.selected_prompts)
                : null,
              dependency_mode: "direct" as DependencyMode,
              created_at: now,
            })),
          )
          .execute();
      }

      // Clean up pinned views for removed connections
      const newIds = new Set(data.connections.map((c) => c.connection_id));
      for (const prevId of previousIds) {
        if (!newIds.has(prevId)) {
          await this.cleanOrphanedPinnedViews([id], prevId);
        }
      }
    }

    const virtualMcp = await this.findById(id);
    if (!virtualMcp) {
      throw new Error("Virtual MCP not found after update");
    }

    return virtualMcp;
  }

  async delete(id: string): Promise<void> {
    // First delete aggregations (no cascade since it's a different relationship)
    await this.db
      .deleteFrom("connection_aggregations")
      .where("parent_connection_id", "=", id)
      .execute();

    // Then delete the connection
    await this.db
      .deleteFrom("connections")
      .where("id", "=", id)
      .where("connection_type", "=", "VIRTUAL")
      .execute();
  }

  async removeConnectionReferences(connectionId: string): Promise<void> {
    // Find all virtual MCPs that reference this connection
    const parentRows = await this.db
      .selectFrom("connection_aggregations")
      .select("parent_connection_id")
      .where("child_connection_id", "=", connectionId)
      .execute();

    // Remove aggregation rows
    await this.db
      .deleteFrom("connection_aggregations")
      .where("child_connection_id", "=", connectionId)
      .execute();

    // Clean up pinned views referencing this connection
    await this.cleanOrphanedPinnedViews(
      parentRows.map((r) => r.parent_connection_id),
      connectionId,
    );
  }

  /**
   * Remove pinned views that reference a specific connection from the given virtual MCPs.
   */
  private async cleanOrphanedPinnedViews(
    virtualMcpIds: string[],
    removedConnectionId: string,
  ): Promise<void> {
    for (const parentId of virtualMcpIds) {
      const row = await this.db
        .selectFrom("connections")
        .select("metadata")
        .where("id", "=", parentId)
        .executeTakeFirst();

      if (!row?.metadata) continue;

      let metadata: Record<string, unknown>;
      try {
        metadata =
          typeof row.metadata === "string"
            ? JSON.parse(row.metadata)
            : (row.metadata as Record<string, unknown>);
      } catch {
        continue;
      }
      const pinnedViews = (metadata?.ui as Record<string, unknown>)
        ?.pinnedViews;
      if (!Array.isArray(pinnedViews)) continue;

      const filtered = pinnedViews.filter(
        (pv: { connectionId: string }) =>
          pv.connectionId !== removedConnectionId,
      );

      if (filtered.length === pinnedViews.length) continue;

      const ui = (metadata.ui as Record<string, unknown>) ?? {};
      const updatedMetadata = {
        ...metadata,
        ui: {
          ...ui,
          pinnedViews: filtered.length > 0 ? filtered : null,
        },
      };

      await this.db
        .updateTable("connections")
        .set({ metadata: JSON.stringify(updatedMetadata) })
        .where("id", "=", parentId)
        .execute();
    }
  }

  /**
   * Deserialize connection row with aggregations to VirtualMCPEntity
   */
  private deserializeVirtualMCPEntity(
    row: RawConnectionRow,
    aggregationRows: RawAggregationRow[],
  ): VirtualMCPEntity {
    // Convert Date to ISO string if needed
    const createdAt =
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at;
    const updatedAt =
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : row.updated_at;

    // Map status - connections can have 'error' but VirtualMCPEntity only has 'active' | 'inactive'
    const status: "active" | "inactive" =
      row.status === "active" ? "active" : "inactive";

    const metadata = this.parseJson<{ instructions?: string }>(row.metadata);

    return {
      id: row.id,
      organization_id: row.organization_id,
      title: row.title,
      description: row.description,
      icon: row.icon,
      status,
      pinned: row.pinned,
      created_at: createdAt,
      updated_at: updatedAt,
      created_by: row.created_by,
      updated_by: row.updated_by ?? undefined,
      metadata: {
        ...metadata,
        instructions: metadata?.instructions ?? null,
      },
      connections: aggregationRows.map((agg) => ({
        connection_id: agg.child_connection_id,
        selected_tools: this.parseJson<string[]>(agg.selected_tools),
        selected_resources: this.parseJson<string[]>(agg.selected_resources),
        selected_prompts: this.parseJson<string[]>(agg.selected_prompts),
      })),
    };
  }

  /**
   * Parse JSON value safely
   */
  private parseJson<T>(value: string | T | null): T | null {
    if (value === null) return null;
    if (typeof value === "string") {
      try {
        return JSON.parse(value) as T;
      } catch {
        return null;
      }
    }
    return value as T;
  }
}
