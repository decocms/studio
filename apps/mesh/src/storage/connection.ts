/**
 * Connection Storage Implementation
 *
 * Handles CRUD operations for MCP connections using Kysely (database-agnostic).
 * All connections are organization-scoped.
 */

import {
  type Insertable,
  type Kysely,
  type RawBuilder,
  sql,
  type SqlBool,
  type Updateable,
} from "kysely";
import type {
  OrderByExpression,
  WhereExpression,
} from "@decocms/bindings/collections";
import type { CredentialVault } from "../encryption/credential-vault";
import type {
  ConnectionEntity,
  ConnectionParameters,
  OAuthConfig,
  StdioConnectionParameters,
} from "../tools/connection/schema";
import { isStdioParameters } from "../tools/connection/schema";
import { generatePrefixedId } from "@/shared/utils/generate-id";
import {
  getWellKnownDecopilotConnection,
  isDecopilot,
} from "@decocms/mesh-sdk";
import { getConnectionSlug } from "@/shared/utils/connection-slug";
import { INTERNAL_VIEWER } from "./ports";
import type { ConnectionStoragePort, ConnectionViewer } from "./ports";
import type { Database } from "./types";
import { deriveAppId } from "./derive-app-id";

/** JSON fields that need serialization/deserialization */
const JSON_FIELDS = [
  "connection_headers",
  "oauth_config",
  "configuration_scopes",
  "metadata",
  "bindings",
] as const;

/** Raw database row type */
type RawConnectionRow = {
  id: string;
  organization_id: string;
  created_by: string;
  updated_by: string | null;
  title: string;
  description: string | null;
  icon: string | null;
  app_name: string | null;
  app_id: string | null;
  slug: string | null;
  connection_type: "HTTP" | "SSE" | "Websocket" | "STDIO" | "VIRTUAL";
  connection_url: string | null;
  connection_token: string | null;
  connection_headers: string | null; // JSON, envVars encrypted for STDIO
  oauth_config: string | OAuthConfig | null;
  configuration_state: string | null; // Encrypted
  configuration_scopes: string | string[] | null;
  metadata: string | Record<string, unknown> | null;
  bindings: string | string[] | null;
  status: "active" | "inactive" | "error";
  access: "user" | "org";
  created_at: Date | string;
  updated_at: Date | string;
};
/** Top-level columns on the connections table that are safe for user-controlled WHERE filtering */
const TOP_LEVEL_COLUMNS = new Set([
  "id",
  "organization_id",
  "created_by",
  "updated_by",
  "title",
  "description",
  "icon",
  "app_name",
  "app_id",
  "slug",
  "connection_type",
  "connection_url",
  // connection_token is intentionally excluded — sensitive
  "status",
  "access",
  "created_at",
  "updated_at",
]);

/** JSON columns that support nested access via ->>. Excludes sensitive columns. */
const JSON_COLUMNS = new Set([
  "metadata",
  // connection_headers excluded — may contain auth headers
  // oauth_config excluded — contains client secrets and tokens
  "configuration_scopes",
  "bindings",
]);

/**
 * Build a SQL reference for a field path.
 * Single-segment paths that match a column become `"column"`.
 * Multi-segment paths where the first segment is a JSON column become `"column"->>'key'`.
 * Returns null for unsupported paths.
 */
function fieldRef(fieldPath: string[]): RawBuilder<unknown> | null {
  if (fieldPath.length === 0) return null;

  const column = fieldPath[0]!;

  if (fieldPath.length === 1 && TOP_LEVEL_COLUMNS.has(column)) {
    return sql.ref(column);
  }

  if (fieldPath.length === 2 && JSON_COLUMNS.has(column)) {
    const key = fieldPath[1]!;
    return sql`${sql.ref(column)}->>${sql.lit(key)}`;
  }

  // Deeper nesting: use #>> for Postgres JSON path
  if (fieldPath.length > 2 && JSON_COLUMNS.has(column)) {
    const path = `{${fieldPath.slice(1).join(",")}}`;
    return sql`${sql.ref(column)}#>>${sql.lit(path)}`;
  }

  // Unknown column — skip (will be ignored)
  return null;
}

/**
 * Translate a WhereExpression tree into a Kysely SQL expression.
 */
function applyWhereToSql(where: WhereExpression): RawBuilder<SqlBool> {
  if ("conditions" in where) {
    const { operator, conditions } = where;
    if (conditions.length === 0) return sql<SqlBool>`true`;

    const parts = conditions.map((c) => applyWhereToSql(c));

    switch (operator) {
      case "and":
        return sql<SqlBool>`(${sql.join(parts, sql` AND `)})`;
      case "or":
        return sql<SqlBool>`(${sql.join(parts, sql` OR `)})`;
      case "not":
        return sql<SqlBool>`NOT (${sql.join(parts, sql` AND `)})`;
      default:
        return sql<SqlBool>`true`;
    }
  }

  const { field, operator, value } = where;
  const ref = fieldRef(field);
  if (!ref) return sql<SqlBool>`true`; // Unknown field — no-op

  switch (operator) {
    case "eq":
      return value === null
        ? sql<SqlBool>`${ref} IS NULL`
        : sql<SqlBool>`${ref} = ${sql.val(value)}`;
    case "gt":
      return sql<SqlBool>`${ref} > ${sql.val(value)}`;
    case "gte":
      return sql<SqlBool>`${ref} >= ${sql.val(value)}`;
    case "lt":
      return sql<SqlBool>`${ref} < ${sql.val(value)}`;
    case "lte":
      return sql<SqlBool>`${ref} <= ${sql.val(value)}`;
    case "in":
      if (!Array.isArray(value) || value.length === 0)
        return sql<SqlBool>`false`;
      return sql<SqlBool>`${ref} IN (${sql.join(value.map((v) => sql.val(v)))})`;
    case "like":
      return sql<SqlBool>`${ref} ILIKE ${sql.val(value)}`;
    case "contains": {
      // Escape LIKE metacharacters so they match literally
      const escaped = String(value).replace(/[%_\\]/g, "\\$&");
      return sql<SqlBool>`${ref} ILIKE ${sql.val(`%${escaped}%`)}`;
    }
    default:
      return sql<SqlBool>`true`;
  }
}

/**
 * Translates the Postgres unique-violation on idx_connections_user_app_unique
 * into a user-facing error. Re-throws anything else untouched.
 */
function rethrowDuplicateConnectionError(err: unknown): never {
  const e = err as { code?: string; constraint?: string; message?: string };
  const isDup =
    e?.code === "23505" &&
    (e?.constraint === "idx_connections_user_app_unique" ||
      (e?.message ?? "").includes("idx_connections_user_app_unique"));
  if (isDup) {
    throw new Error(
      "A private connection for this service already exists. Each service can have only one private connection per user.",
    );
  }
  throw err;
}

export class ConnectionStorage implements ConnectionStoragePort {
  constructor(
    private db: Kysely<Database>,
    private vault: CredentialVault,
  ) {}

  async create(data: Partial<ConnectionEntity>): Promise<ConnectionEntity> {
    const id = data.id ?? generatePrefixedId("conn");
    const now = new Date().toISOString();

    const existing = await this.findById(id, undefined, INTERNAL_VIEWER);

    if (existing) {
      // Only allow update if same organization - prevent cross-org hijacking
      if (existing.organization_id !== data.organization_id) {
        throw new Error("Connection ID already exists");
      }
      return this.update(id, data);
    }

    const slug = getConnectionSlug(data);
    const serialized = await this.serializeConnection({
      ...data,
      app_id: deriveAppId(data),
      id: data.id ?? id,
      slug,
      status: "active",
      created_at: now,
      updated_at: now,
    });
    try {
      await this.db
        .insertInto("connections")
        .values(serialized as Insertable<Database["connections"]>)
        .execute();
    } catch (err) {
      rethrowDuplicateConnectionError(err);
    }

    const connection = await this.findById(id, undefined, INTERNAL_VIEWER);
    if (!connection) {
      throw new Error(`Failed to create connection with id: ${id}`);
    }

    return connection;
  }

  async findById(
    id: string,
    organizationId: string | undefined,
    viewer: ConnectionViewer,
  ): Promise<ConnectionEntity | null> {
    // Handle Decopilot ID - return Decopilot connection entity
    const decopilotOrgId = isDecopilot(id);
    if (decopilotOrgId) {
      const resolvedOrgId = organizationId ?? decopilotOrgId;
      return getWellKnownDecopilotConnection(resolvedOrgId);
    }

    let query = this.db
      .selectFrom("connections")
      .selectAll()
      .where("id", "=", id);

    if (organizationId) {
      query = query.where("organization_id", "=", organizationId);
    }

    const row = await query.executeTakeFirst();
    if (!row) return null;

    const rawRow = row as RawConnectionRow;

    // Visibility filter: hide other users' user-private connections from the caller.
    // `viewer` is required and explicit — callers must opt into INTERNAL_VIEWER to
    // bypass the per-user filter. A string viewer is the user's id; null is an
    // unauthenticated/system caller and only sees org-shared rows.
    if (viewer !== INTERNAL_VIEWER) {
      if (rawRow.access === "user") {
        if (viewer === null || rawRow.created_by !== viewer) {
          return null;
        }
      }
    }

    return this.deserializeConnection(rawRow);
  }

  async list(
    organizationId: string,
    options: {
      includeVirtual?: boolean;
      slug?: string;
      where?: WhereExpression;
      orderBy?: OrderByExpression[];
      limit?: number;
      offset?: number;
      viewer: ConnectionViewer;
    },
  ): Promise<{ items: ConnectionEntity[]; totalCount: number }> {
    let query = this.db
      .selectFrom("connections")
      .selectAll()
      .where("organization_id", "=", organizationId);

    // Per-user visibility: hide other users' user-private connections.
    // `viewer` is required so callers must opt into INTERNAL_VIEWER to see
    // every row. A string viewer is the user's id; null is an unauthenticated
    // /system caller and only sees org-shared rows.
    if (options.viewer !== INTERNAL_VIEWER) {
      if (options.viewer === null) {
        // Explicit null viewer (system / unauthenticated) → only org-shared rows.
        query = query.where("access", "=", "org");
      } else {
        const viewerUserId = options.viewer;
        query = query.where((eb) =>
          eb.or([
            eb("access", "=", "org"),
            eb.and([
              eb("access", "=", "user"),
              eb("created_by", "=", viewerUserId),
            ]),
          ]),
        );
      }
    }

    // By default, exclude VIRTUAL connections unless explicitly requested
    if (!options?.includeVirtual) {
      query = query.where("connection_type", "!=", "VIRTUAL");
    }

    if (options?.slug) {
      query = query.where("slug", "=", options.slug);
    }

    // Apply where expression to SQL
    if (options?.where) {
      query = query.where(applyWhereToSql(options.where));
    }

    // Count before pagination
    const countQuery = this.db
      .selectFrom(query.as("filtered"))
      .select(sql<number>`count(*)::int`.as("count"));
    const countResult = await countQuery.executeTakeFirst();
    const totalCount = countResult?.count ?? 0;

    // Apply orderBy
    if (options?.orderBy && options.orderBy.length > 0) {
      for (const order of options.orderBy) {
        const ref = fieldRef(order.field);
        if (!ref) continue;
        const dir = order.direction === "desc" ? sql`desc` : sql`asc`;
        const nulls =
          order.nulls === "first" ? sql`nulls first` : sql`nulls last`;
        query = query.orderBy(sql`${ref} ${dir} ${nulls}`);
      }
    }

    // Apply pagination
    if (options?.limit) {
      query = query.limit(options.limit);
    }
    if (options?.offset) {
      query = query.offset(options.offset);
    }

    const rows = await query.execute();

    const items = await Promise.all(
      rows.map((row) => this.deserializeConnection(row as RawConnectionRow)),
    );

    return { items, totalCount };
  }

  async update(
    id: string,
    data: Partial<ConnectionEntity>,
  ): Promise<ConnectionEntity> {
    if (Object.keys(data).length === 0) {
      const connection = await this.findById(id, undefined, INTERNAL_VIEWER);
      if (!connection) throw new Error("Connection not found");
      return connection;
    }

    const slugData: Record<string, unknown> = { ...data };

    // Reload existing once if we need it for slug recomputation or app_id
    // re-derivation.
    const needsExisting =
      data.app_name !== undefined ||
      data.connection_url !== undefined ||
      data.title !== undefined ||
      data.connection_headers !== undefined ||
      data.connection_type !== undefined;
    const existing = needsExisting
      ? await this.findById(id, undefined, INTERNAL_VIEWER)
      : null;

    // Recompute slug if any slug-relevant field changed
    if (
      existing &&
      (data.app_name !== undefined ||
        data.connection_url !== undefined ||
        data.title !== undefined)
    ) {
      slugData.slug = getConnectionSlug({
        app_name: data.app_name ?? existing.app_name,
        connection_url: data.connection_url ?? existing.connection_url,
        title: data.title ?? existing.title,
        id,
      });
    }

    // Re-derive app_id when transport details change. deriveAppId preserves a
    // real registry app_id and only recomputes null/synthetic ids.
    if (
      existing &&
      (data.connection_url !== undefined ||
        data.connection_headers !== undefined ||
        data.connection_type !== undefined)
    ) {
      slugData.app_id = deriveAppId({
        connection_type: data.connection_type ?? existing.connection_type,
        connection_url: data.connection_url ?? existing.connection_url,
        connection_headers:
          data.connection_headers ?? existing.connection_headers,
        app_id: data.app_id ?? existing.app_id,
      });
    }

    const serialized = await this.serializeConnection({
      ...slugData,
      updated_at: new Date().toISOString(),
    });

    try {
      await this.db
        .updateTable("connections")
        .set(serialized)
        .where("id", "=", id)
        .execute();
    } catch (err) {
      rethrowDuplicateConnectionError(err);
    }

    const connection = await this.findById(id, undefined, INTERNAL_VIEWER);
    if (!connection) {
      throw new Error("Connection not found after update");
    }

    return connection;
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom("connections").where("id", "=", id).execute();
  }

  async testConnection(
    id: string,
    headers?: Record<string, string>,
  ): Promise<{ healthy: boolean; latencyMs: number }> {
    const connection = await this.findById(id, undefined, INTERNAL_VIEWER);
    if (!connection) {
      throw new Error("Connection not found");
    }

    const startTime = Date.now();

    // STDIO connections can't be tested via HTTP
    if (connection.connection_type === "STDIO") {
      // For STDIO, we'd need to spawn the process - skip for now
      return {
        healthy: true, // Assume healthy, actual health checked on first use
        latencyMs: Date.now() - startTime,
      };
    }

    if (!connection.connection_url) {
      return {
        healthy: false,
        latencyMs: Date.now() - startTime,
      };
    }

    try {
      const httpParams = connection.connection_headers as {
        headers?: Record<string, string>;
      } | null;

      const response = await fetch(connection.connection_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(connection.connection_token && {
            Authorization: `Bearer ${connection.connection_token}`,
          }),
          ...httpParams?.headers,
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "ping",
          id: 1,
        }),
      });

      return {
        healthy: response.ok || response.status === 404,
        latencyMs: Date.now() - startTime,
      };
    } catch {
      return {
        healthy: false,
        latencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Serialize entity data to database format
   */
  private async serializeConnection(
    data: Partial<ConnectionEntity>,
  ): Promise<Updateable<Database["connections"]>> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      // tools column was dropped — skip to avoid inserting into non-existent column
      if (key === "tools") continue;

      if (key === "connection_token" && value) {
        result[key] = await this.vault.encrypt(value as string);
      } else if (key === "configuration_state" && value) {
        // Encrypt configuration state
        const stateJson = JSON.stringify(value);
        result[key] = await this.vault.encrypt(stateJson);
      } else if (key === "connection_headers" && value) {
        // For STDIO, encrypt envVars before storing
        const params = value as ConnectionParameters;
        if (isStdioParameters(params) && params.envVars) {
          const encryptedEnvVars: Record<string, string> = {};
          for (const [envKey, envValue] of Object.entries(params.envVars)) {
            encryptedEnvVars[envKey] = await this.vault.encrypt(envValue);
          }
          result[key] = JSON.stringify({
            ...params,
            envVars: encryptedEnvVars,
          });
        } else {
          result[key] = JSON.stringify(params);
        }
      } else if (JSON_FIELDS.includes(key as (typeof JSON_FIELDS)[number])) {
        result[key] = value ? JSON.stringify(value) : null;
      } else {
        result[key] = value;
      }
    }

    return result as Updateable<Database["connections"]>;
  }

  /**
   * Deserialize database row to entity
   */
  private async deserializeConnection(
    row: RawConnectionRow,
  ): Promise<ConnectionEntity> {
    let decryptedToken: string | null = null;
    if (row.connection_token) {
      try {
        decryptedToken = await this.vault.decrypt(row.connection_token);
      } catch (error) {
        console.error(
          `Failed to decrypt connection token for connection ${row.id} (org: ${row.organization_id}, type: ${row.connection_type}, title: ${row.title}):`,
          error,
        );
      }
    }

    // Decrypt configuration state
    let decryptedConfigState: Record<string, unknown> | null = null;
    if (row.configuration_state) {
      try {
        const decryptedJson = await this.vault.decrypt(row.configuration_state);
        decryptedConfigState = JSON.parse(decryptedJson);
      } catch (error) {
        console.error(
          `Failed to decrypt configuration state for connection ${row.id} (org: ${row.organization_id}, type: ${row.connection_type}, title: ${row.title}):`,
          error,
        );
      }
    }

    // Parse and decrypt connection_headers
    let connectionParameters: ConnectionParameters | null = null;
    if (row.connection_headers) {
      try {
        const parsed = JSON.parse(row.connection_headers);
        // For STDIO, decrypt envVars
        if (isStdioParameters(parsed) && parsed.envVars) {
          const decryptedEnvVars: Record<string, string> = {};
          for (const [envKey, envValue] of Object.entries(parsed.envVars)) {
            try {
              decryptedEnvVars[envKey] = await this.vault.decrypt(
                envValue as string,
              );
            } catch {
              // If decryption fails, keep encrypted value (migration case)
              decryptedEnvVars[envKey] = envValue as string;
            }
          }
          connectionParameters = {
            ...parsed,
            envVars: decryptedEnvVars,
          } as StdioConnectionParameters;
        } else {
          connectionParameters = parsed;
        }
      } catch (error) {
        console.error(
          `Failed to parse connection_headers for connection ${row.id} (org: ${row.organization_id}, type: ${row.connection_type}, title: ${row.title}):`,
          error,
        );
      }
    }

    const parseJson = <T>(value: string | T | null): T | null => {
      if (value === null) return null;
      if (typeof value === "string") {
        try {
          return JSON.parse(value) as T;
        } catch {
          return null;
        }
      }
      return value as T;
    };

    return {
      id: row.id,
      organization_id: row.organization_id,
      created_by: row.created_by,
      updated_by: row.updated_by ?? undefined,
      title: row.title,
      description: row.description,
      icon: row.icon,
      app_name: row.app_name,
      app_id: row.app_id,
      slug: row.slug,
      connection_type: row.connection_type,
      connection_url: row.connection_url,
      connection_token: decryptedToken,
      connection_headers: connectionParameters,
      oauth_config: parseJson<OAuthConfig>(row.oauth_config),
      configuration_state: decryptedConfigState,
      configuration_scopes: parseJson<string[]>(row.configuration_scopes),
      metadata: parseJson<Record<string, unknown>>(row.metadata),
      tools: null,
      bindings: parseJson<string[]>(row.bindings),
      status: row.status,
      access: row.access ?? "user",
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }
}
