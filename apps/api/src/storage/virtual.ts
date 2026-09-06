/**
 * Virtual MCP Storage Implementation
 *
 * This is now a FACADE over the connections table.
 * Virtual MCPs are stored as connections with connection_type = 'VIRTUAL'.
 * The aggregations (which child connections are included) are stored in
 * the connection_aggregations table.
 */

import type { Kysely } from "kysely";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";
import {
  getWellKnownBrandContextSetupVirtualMCP,
  getWellKnownDecopilotVirtualMCP,
  isBrandContextSetup,
  isDecopilot,
  normalizeSandboxMap,
} from "@decocms/shared/sdk";
import type {
  VirtualMCPCreateData,
  VirtualMCPEntity,
  VirtualMCPStoragePort,
  VirtualMCPUpdateData,
} from "./ports";
import type { Database, DependencyMode } from "./types";
import { pruneOrphanedUiRefs } from "./prune-orphaned-ui-refs";

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

/** One cross-organization search hit: enough to draw a row, no aggregations. */
export interface CrossOrgProjectMatch {
  id: string;
  title: string;
  icon: string | null;
  metadata: Record<string, unknown> | null;
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  /** Raw `organization.metadata` JSON — carries the `archived` soft-delete
   *  flag, which every other surface honours (`isOrgArchived`). */
  organization_metadata: string | null;
}

/** Neutralise the wildcards a user can type. Without this a lone `%` matches
 *  every project in every organization the caller belongs to — a search box
 *  that dumps the account. Postgres LIKE treats backslash as the escape
 *  character by default, so escaping it first keeps the other two honest. */
export function escapeLikePattern(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export class VirtualMCPStorage implements VirtualMCPStoragePort {
  constructor(private db: Kysely<Database>) {}

  async create(
    organizationId: string,
    userId: string,
    data: VirtualMCPCreateData,
    options?: { id?: string },
  ): Promise<VirtualMCPEntity> {
    const id = options?.id ?? generatePrefixedId("vir");
    const now = new Date().toISOString();

    await this.db.transaction().execute(async (trx) => {
      // Insert as a VIRTUAL connection
      await trx
        .insertInto("connections")
        .values({
          id,
          organization_id: organizationId,
          created_by: userId,
          updated_by: userId,
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
        await trx
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
    });

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
    // Handle Decopilot ID — Decopilot is a pure orchestrator with no aggregated tools.
    const decopilotOrgId = isDecopilot(id);
    if (decopilotOrgId) {
      const resolvedOrgId = organizationId ?? decopilotOrgId;
      return {
        ...getWellKnownDecopilotVirtualMCP(resolvedOrgId),
        pinned: false,
        connections: [],
      };
    }

    // Well-known guided-onboarding agent for the brand-context preset.
    const bcsOrgId = isBrandContextSetup(id);
    if (bcsOrgId) {
      const resolvedOrgId = organizationId ?? bcsOrgId;
      return {
        ...getWellKnownBrandContextSetupVirtualMCP(resolvedOrgId),
        pinned: false,
        connections: [],
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

  /**
   * Projects matching `term` across every organization the caller belongs
   * to.
   */
  async searchAcrossMemberships(options: {
    userId: string;
    term: string;
    limit: number;
    /** Page offset. The caller drops rows it may not show (plumbing rows,
     *  archived orgs, SSO-blocked orgs) and pages on to refill its page, so a
     *  page full of hidden rows no longer truncates the answer. */
    offset?: number;
    /** Fence a credential-authenticated caller to one organization. Applied in
     *  SQL, BEFORE `LIMIT`: filtering the page afterwards let another org's
     *  more recent matches crowd out the fenced org's rows entirely. */
    organizationId?: string | null;
  }): Promise<CrossOrgProjectMatch[]> {
    const { userId, term, limit, offset = 0, organizationId } = options;
    const pattern = `%${escapeLikePattern(term)}%`;

    let query = this.db
      .selectFrom("connections")
      .innerJoin("member", (join) =>
        join
          .onRef("member.organizationId", "=", "connections.organization_id")
          .on("member.userId", "=", userId),
      )
      .innerJoin(
        "organization",
        "organization.id",
        "connections.organization_id",
      )
      .where("connections.connection_type", "=", "VIRTUAL")
      .where((eb) =>
        eb.or([
          eb("connections.title", "ilike", pattern),
          eb("connections.description", "ilike", pattern),
        ]),
      );

    if (organizationId) {
      query = query.where("connections.organization_id", "=", organizationId);
    }

    const rows = await query
      .select([
        "connections.id as id",
        "connections.title as title",
        "connections.icon as icon",
        "connections.metadata as metadata",
        "connections.organization_id as organization_id",
        "organization.name as organization_name",
        "organization.slug as organization_slug",
        "organization.metadata as organization_metadata",
      ])
      .orderBy("connections.updated_at", "desc")
      .orderBy("connections.id", "asc")
      .limit(limit)
      .offset(offset)
      .execute();

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      icon: row.icon,
      // `connections.metadata` is a TEXT column holding JSON, so the driver hands back a string: a consumer reading `metadata.liveAgentId` off the raw value always saw `undefined` and let dev-agent rows through.
      metadata: this.parseJson<Record<string, unknown>>(row.metadata),
      organization_id: row.organization_id,
      organization_name: row.organization_name,
      organization_slug: row.organization_slug,
      organization_metadata: row.organization_metadata,
    }));
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

    /** Oldest first, id as the tiebreaker. Without an ORDER BY, Postgres
     *  returns heap order, which an UPDATE reshuffles — so `items[0]` flapped
     *  (it is the sidebar's display target) and `slice(offset, offset + limit)`
     *  in the list tool could repeat one row across pages and skip another. */
    const rows = await query
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
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

  async listByIds(
    organizationId: string,
    ids: string[],
  ): Promise<VirtualMCPEntity[]> {
    if (ids.length === 0) return [];

    const rows = await this.db
      .selectFrom("connections")
      .selectAll()
      .where("id", "in", ids)
      .where("organization_id", "=", organizationId)
      .where("connection_type", "=", "VIRTUAL")
      .execute();

    if (rows.length === 0) return [];

    const virtualMcpIds = rows.map((r) => r.id);

    const aggregationRows = await this.db
      .selectFrom("connection_aggregations")
      .selectAll()
      .where("parent_connection_id", "in", virtualMcpIds)
      .where("dependency_mode", "=", "direct")
      .execute();

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

    const removedConnectionIds: string[] = [];

    await this.db.transaction().execute(async (trx) => {
      // Update the connection
      await trx
        .updateTable("connections")
        .set(updateData)
        .where("id", "=", id)
        .where("connection_type", "=", "VIRTUAL")
        .execute();

      // Update aggregations if provided
      if (data.connections !== undefined) {
        // Collect current direct connection IDs before removing them
        const currentAggs = await trx
          .selectFrom("connection_aggregations")
          .select("child_connection_id")
          .where("parent_connection_id", "=", id)
          .where("dependency_mode", "=", "direct")
          .execute();
        const previousIds = new Set(
          currentAggs.map((a) => a.child_connection_id),
        );

        // Only delete 'direct' dependencies - preserve 'indirect' ones from virtual tools
        await trx
          .deleteFrom("connection_aggregations")
          .where("parent_connection_id", "=", id)
          .where("dependency_mode", "=", "direct")
          .execute();

        if (data.connections.length > 0) {
          await trx
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

        // Clean up pinned views for removed connections after the transaction commits.
        const newIds = new Set(data.connections.map((c) => c.connection_id));
        for (const prevId of previousIds) {
          if (!newIds.has(prevId)) {
            removedConnectionIds.push(prevId);
          }
        }
      }
    });

    for (const prevId of removedConnectionIds) {
      await this.cleanOrphanedPinnedViews([id], prevId);
    }

    const virtualMcp = await this.findById(id);
    if (!virtualMcp) {
      throw new Error("Virtual MCP not found after update");
    }

    return virtualMcp;
  }

  async delete(id: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      // Delete threads initiated with this agent.
      await trx
        .deleteFrom("threads")
        .where("virtual_mcp_id", "=", id)
        .execute();

      // Delete aggregations (no cascade since it's a different relationship)
      await trx
        .deleteFrom("connection_aggregations")
        .where("parent_connection_id", "=", id)
        .execute();

      // Then delete the connection
      await trx
        .deleteFrom("connections")
        .where("id", "=", id)
        .where("connection_type", "=", "VIRTUAL")
        .execute();
    });
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
   * Remove pinned views and home tiles that reference a specific connection
   * from the given virtual MCPs.
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
      const ui = (metadata.ui as Record<string, unknown>) ?? null;
      if (!ui) continue;

      const { ui: prunedUi, changed } = pruneOrphanedUiRefs(
        ui,
        removedConnectionId,
      );
      if (!changed) continue;

      const updatedMetadata = { ...metadata, ui: prunedUi };

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

    const rawMetadata = this.parseJson<{
      instructions?: string;
      sandboxMap?: unknown;
    }>(row.metadata);

    // Migration 091 rewrote every row to the canonical `sandboxMap` key with the strict 3-level shape;
    const { sandboxMap: rawSandboxMap, ...metadataRest } = rawMetadata ?? {};
    const normalizedSandboxMap =
      rawSandboxMap !== undefined
        ? normalizeSandboxMap(rawSandboxMap)
        : undefined;

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
        ...metadataRest,
        instructions: rawMetadata?.instructions ?? null,
        ...(normalizedSandboxMap !== undefined
          ? { sandboxMap: normalizedSandboxMap }
          : {}),
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

/**
 * Wrap a (singleton) VirtualMCPStorage so `list` is memoized for the
 * lifetime of one request.
 */
export function createRequestCachedVirtualMcps(
  base: VirtualMCPStorage,
): VirtualMCPStorage {
  const cache = new Map<string, Promise<unknown>>();
  const memoize = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key);
    if (hit) return hit as Promise<T>;
    const promise = fn();
    cache.set(key, promise);
    return promise;
  };

  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "list") {
        return (organizationId: string, options?: { pinnedOnly?: boolean }) =>
          memoize(`list:${organizationId}:${options?.pinnedOnly ? 1 : 0}`, () =>
            target.list(organizationId, options),
          );
      }
      if (
        prop === "create" ||
        prop === "update" ||
        prop === "delete" ||
        prop === "removeConnectionReferences"
      ) {
        return (...args: unknown[]) => {
          cache.clear();
          return (target[prop] as (...a: unknown[]) => unknown)(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
