/**
 * Virtual MCP Storage Implementation
 *
 * This is now a FACADE over the connections table.
 * Virtual MCPs are stored as connections with connection_type = 'VIRTUAL'.
 * The aggregations (which child connections are included) are stored in
 * the connection_aggregations table.
 *
 * Virtual tools are stored in the connections.tools JSON column and are
 * identified by having _meta["mcp.mesh"]["tool.fn"] containing their code.
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
  VirtualToolEntity,
  VirtualToolCreateData,
  VirtualToolUpdateData,
} from "./ports";
import type { ToolDefinition } from "../tools/connection/schema";
import {
  type VirtualToolDefinition,
  isVirtualTool,
  fromVirtualToolDefinition,
} from "../tools/virtual-tool/schema";
import type { Database, DependencyMode } from "./types";

/** Raw database row type for connections (VIRTUAL type) */
type RawConnectionRow = {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  icon: string | null;
  status: "active" | "inactive" | "error";
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
        connection_url: `virtual://${id}`,
        connection_token: null,
        connection_headers: null,
        oauth_config: null,
        configuration_state: null,
        configuration_scopes: null,
        metadata: data.metadata ? JSON.stringify(data.metadata) : null,
        tools: null,
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

  async list(organizationId: string): Promise<VirtualMCPEntity[]> {
    const rows = await this.db
      .selectFrom("connections")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("connection_type", "=", "VIRTUAL")
      .execute();

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
    await this.db
      .deleteFrom("connection_aggregations")
      .where("child_connection_id", "=", connectionId)
      .execute();
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

  // ============================================================================
  // Virtual Tool CRUD Methods
  // ============================================================================

  /**
   * List all virtual tools for a Virtual MCP
   * Virtual tools are stored in the tools column and identified by _meta["mcp.mesh"]["tool.fn"]
   */
  async listVirtualTools(virtualMcpId: string): Promise<VirtualToolEntity[]> {
    const row = await this.db
      .selectFrom("connections")
      .select(["tools", "created_at", "updated_at"])
      .where("id", "=", virtualMcpId)
      .where("connection_type", "=", "VIRTUAL")
      .executeTakeFirst();

    if (!row) {
      return [];
    }

    const tools = this.parseJson<ToolDefinition[]>(
      row.tools as string | ToolDefinition[] | null,
    );
    if (!tools) {
      return [];
    }

    const createdAt =
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : (row.created_at as string);
    const updatedAt =
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : (row.updated_at as string);

    // Filter for virtual tools and convert to entity format
    // Preserve the original array index for consistent IDs with getVirtualTool
    return tools
      .map((tool, originalIndex) => ({ tool, originalIndex }))
      .filter(({ tool }) => isVirtualTool(tool))
      .map(({ tool, originalIndex }) =>
        fromVirtualToolDefinition(
          `${virtualMcpId}:${tool.name}:${originalIndex}`,
          tool as VirtualToolDefinition,
          createdAt,
          updatedAt,
        ),
      );
  }

  /**
   * Get a specific virtual tool by name
   */
  async getVirtualTool(
    virtualMcpId: string,
    toolName: string,
  ): Promise<VirtualToolEntity | null> {
    const row = await this.db
      .selectFrom("connections")
      .select(["tools", "created_at", "updated_at"])
      .where("id", "=", virtualMcpId)
      .where("connection_type", "=", "VIRTUAL")
      .executeTakeFirst();

    if (!row) {
      return null;
    }

    const tools = this.parseJson<ToolDefinition[]>(
      row.tools as string | ToolDefinition[] | null,
    );
    if (!tools) {
      return null;
    }

    const toolIndex = tools.findIndex(
      (t) => t.name === toolName && isVirtualTool(t),
    );
    if (toolIndex === -1) {
      return null;
    }

    const tool = tools[toolIndex] as VirtualToolDefinition;
    const createdAt =
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : (row.created_at as string);
    const updatedAt =
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : (row.updated_at as string);

    return fromVirtualToolDefinition(
      `${virtualMcpId}:${tool.name}:${toolIndex}`,
      tool,
      createdAt,
      updatedAt,
    );
  }

  /**
   * Create a new virtual tool in a Virtual MCP
   */
  async createVirtualTool(
    virtualMcpId: string,
    data: VirtualToolCreateData,
    connectionDependencies: string[],
  ): Promise<VirtualToolEntity> {
    const now = new Date().toISOString();

    // Get current tools
    const row = await this.db
      .selectFrom("connections")
      .select(["tools"])
      .where("id", "=", virtualMcpId)
      .where("connection_type", "=", "VIRTUAL")
      .executeTakeFirst();

    if (!row) {
      throw new Error(`Virtual MCP not found: ${virtualMcpId}`);
    }

    const tools =
      this.parseJson<ToolDefinition[]>(
        row.tools as string | ToolDefinition[] | null,
      ) ?? [];

    // Check for duplicate name
    if (tools.some((t) => t.name === data.name)) {
      throw new Error(`Tool with name "${data.name}" already exists`);
    }

    // Create virtual tool definition
    const virtualToolDef: VirtualToolDefinition = {
      name: data.name,
      description: data.description,
      inputSchema: data.inputSchema,
      outputSchema: data.outputSchema,
      annotations: data.annotations,
      _meta: {
        "mcp.mesh": {
          "tool.fn": data.code,
        },
        connectionDependencies,
      },
    };

    // Add to tools array
    tools.push(virtualToolDef);

    // Update the connection
    await this.db
      .updateTable("connections")
      .set({
        tools: JSON.stringify(tools),
        updated_at: now,
      })
      .where("id", "=", virtualMcpId)
      .execute();

    // Sync indirect dependencies
    await this.syncIndirectDependencies(virtualMcpId, connectionDependencies);

    return fromVirtualToolDefinition(
      `${virtualMcpId}:${data.name}:${tools.length - 1}`,
      virtualToolDef,
      now,
      now,
    );
  }

  /**
   * Update an existing virtual tool
   */
  async updateVirtualTool(
    virtualMcpId: string,
    toolName: string,
    data: VirtualToolUpdateData,
    connectionDependencies?: string[],
  ): Promise<VirtualToolEntity> {
    const now = new Date().toISOString();

    // Get current tools
    const row = await this.db
      .selectFrom("connections")
      .select(["tools", "created_at"])
      .where("id", "=", virtualMcpId)
      .where("connection_type", "=", "VIRTUAL")
      .executeTakeFirst();

    if (!row) {
      throw new Error(`Virtual MCP not found: ${virtualMcpId}`);
    }

    const tools =
      this.parseJson<ToolDefinition[]>(
        row.tools as string | ToolDefinition[] | null,
      ) ?? [];

    // Find the tool
    const toolIndex = tools.findIndex(
      (t) => t.name === toolName && isVirtualTool(t),
    );
    if (toolIndex === -1) {
      throw new Error(`Virtual tool not found: ${toolName}`);
    }

    const existingTool = tools[toolIndex] as VirtualToolDefinition;

    // Check for name conflict if renaming
    if (data.name && data.name !== toolName) {
      if (tools.some((t) => t.name === data.name)) {
        throw new Error(`Tool with name "${data.name}" already exists`);
      }
    }

    // Get dependencies - use new ones if provided, otherwise keep existing
    const newDependencies =
      connectionDependencies ?? existingTool._meta.connectionDependencies ?? [];

    // Update the tool
    const updatedTool: VirtualToolDefinition = {
      name: data.name ?? existingTool.name,
      description:
        data.description !== undefined
          ? (data.description ?? undefined)
          : existingTool.description,
      inputSchema: data.inputSchema ?? existingTool.inputSchema,
      outputSchema:
        data.outputSchema !== undefined
          ? (data.outputSchema ?? undefined)
          : existingTool.outputSchema,
      annotations:
        data.annotations !== undefined
          ? (data.annotations ?? undefined)
          : existingTool.annotations,
      _meta: {
        "mcp.mesh": {
          "tool.fn": data.code ?? existingTool._meta["mcp.mesh"]["tool.fn"],
        },
        connectionDependencies: newDependencies,
      },
    };

    tools[toolIndex] = updatedTool;

    // Update the connection
    await this.db
      .updateTable("connections")
      .set({
        tools: JSON.stringify(tools),
        updated_at: now,
      })
      .where("id", "=", virtualMcpId)
      .execute();

    // Sync indirect dependencies if they were provided
    if (connectionDependencies !== undefined) {
      // Recalculate all indirect dependencies from all virtual tools
      await this.recalculateIndirectDependencies(virtualMcpId, tools);
    }

    const createdAt =
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : (row.created_at as string);

    return fromVirtualToolDefinition(
      `${virtualMcpId}:${updatedTool.name}:${toolIndex}`,
      updatedTool,
      createdAt,
      now,
    );
  }

  /**
   * Delete a virtual tool from a Virtual MCP
   */
  async deleteVirtualTool(
    virtualMcpId: string,
    toolName: string,
  ): Promise<void> {
    const now = new Date().toISOString();

    // Get current tools
    const row = await this.db
      .selectFrom("connections")
      .select(["tools"])
      .where("id", "=", virtualMcpId)
      .where("connection_type", "=", "VIRTUAL")
      .executeTakeFirst();

    if (!row) {
      throw new Error(`Virtual MCP not found: ${virtualMcpId}`);
    }

    const tools =
      this.parseJson<ToolDefinition[]>(
        row.tools as string | ToolDefinition[] | null,
      ) ?? [];

    // Find and remove the tool
    const toolIndex = tools.findIndex(
      (t) => t.name === toolName && isVirtualTool(t),
    );
    if (toolIndex === -1) {
      throw new Error(`Virtual tool not found: ${toolName}`);
    }

    tools.splice(toolIndex, 1);

    // Update the connection
    await this.db
      .updateTable("connections")
      .set({
        tools: tools.length > 0 ? JSON.stringify(tools) : null,
        updated_at: now,
      })
      .where("id", "=", virtualMcpId)
      .execute();

    // Recalculate indirect dependencies
    await this.recalculateIndirectDependencies(virtualMcpId, tools);
  }

  // ============================================================================
  // Indirect Dependency Management
  // ============================================================================

  /**
   * Sync indirect dependencies for a Virtual MCP
   * Adds any new connection dependencies as 'indirect' aggregations
   */
  async syncIndirectDependencies(
    virtualMcpId: string,
    connectionIds: string[],
  ): Promise<void> {
    if (connectionIds.length === 0) {
      return;
    }

    const now = new Date().toISOString();

    // Get existing aggregations
    const existingAggregations = await this.db
      .selectFrom("connection_aggregations")
      .select(["child_connection_id", "dependency_mode"])
      .where("parent_connection_id", "=", virtualMcpId)
      .execute();

    const existingConnectionIds = new Set(
      existingAggregations.map((a) => a.child_connection_id),
    );

    // Find new indirect dependencies (not already in aggregations)
    const newIndirectDeps = connectionIds.filter(
      (id) => !existingConnectionIds.has(id),
    );

    if (newIndirectDeps.length > 0) {
      await this.db
        .insertInto("connection_aggregations")
        .values(
          newIndirectDeps.map((connectionId) => ({
            id: generatePrefixedId("agg"),
            parent_connection_id: virtualMcpId,
            child_connection_id: connectionId,
            selected_tools: null,
            selected_resources: null,
            selected_prompts: null,
            dependency_mode: "indirect" as DependencyMode,
            created_at: now,
          })),
        )
        .execute();
    }
  }

  /**
   * Recalculate all indirect dependencies from virtual tools
   * Called after updating or deleting virtual tools
   */
  private async recalculateIndirectDependencies(
    virtualMcpId: string,
    tools: ToolDefinition[],
  ): Promise<void> {
    // Collect all connection dependencies from virtual tools
    const allDependencies = new Set<string>();
    for (const tool of tools) {
      if (isVirtualTool(tool)) {
        const deps =
          (tool as VirtualToolDefinition)._meta.connectionDependencies ?? [];
        for (const dep of deps) {
          allDependencies.add(dep);
        }
      }
    }

    // Get existing aggregations
    const existingAggregations = await this.db
      .selectFrom("connection_aggregations")
      .select(["id", "child_connection_id", "dependency_mode"])
      .where("parent_connection_id", "=", virtualMcpId)
      .execute();

    // Find indirect deps that are no longer needed
    const indirectToRemove = existingAggregations
      .filter(
        (a) =>
          a.dependency_mode === "indirect" &&
          !allDependencies.has(a.child_connection_id),
      )
      .map((a) => a.id);

    // Remove orphaned indirect dependencies
    if (indirectToRemove.length > 0) {
      await this.db
        .deleteFrom("connection_aggregations")
        .where("id", "in", indirectToRemove)
        .execute();
    }

    // Add any new indirect dependencies
    const existingDirectAndIndirect = new Set(
      existingAggregations.map((a) => a.child_connection_id),
    );
    const newIndirect = Array.from(allDependencies).filter(
      (id) => !existingDirectAndIndirect.has(id),
    );

    if (newIndirect.length > 0) {
      const now = new Date().toISOString();
      await this.db
        .insertInto("connection_aggregations")
        .values(
          newIndirect.map((connectionId) => ({
            id: generatePrefixedId("agg"),
            parent_connection_id: virtualMcpId,
            child_connection_id: connectionId,
            selected_tools: null,
            selected_resources: null,
            selected_prompts: null,
            dependency_mode: "indirect" as DependencyMode,
            created_at: now,
          })),
        )
        .execute();
    }
  }
}
