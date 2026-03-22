/**
 * Connection Storage Implementation
 *
 * Handles CRUD operations for MCP connections using Kysely (database-agnostic).
 * All connections are organization-scoped.
 */

import type { Insertable, Kysely, Updateable } from "kysely";
import type { CredentialVault } from "../encryption/credential-vault";
import type {
  ConnectionEntity,
  ConnectionParameters,
  OAuthConfig,
  StdioConnectionParameters,
} from "../tools/connection/schema";
import { isStdioParameters } from "../tools/connection/schema";
import { generateConnectionId } from "@/shared/utils/generate-id";
import {
  getWellKnownDecopilotConnection,
  isDecopilot,
} from "@decocms/mesh-sdk";
import type { ConnectionStoragePort } from "./ports";
import type { Database } from "./types";

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
  created_at: Date | string;
  updated_at: Date | string;
};
export class ConnectionStorage implements ConnectionStoragePort {
  constructor(
    private db: Kysely<Database>,
    private vault: CredentialVault,
  ) {}

  async create(data: Partial<ConnectionEntity>): Promise<ConnectionEntity> {
    const id = data.id ?? generateConnectionId(data.title ?? "");
    const now = new Date().toISOString();

    const existing = await this.findById(id);

    if (existing) {
      // Only allow update if same organization - prevent cross-org hijacking
      if (existing.organization_id !== data.organization_id) {
        throw new Error("Connection ID already exists");
      }
      return this.update(id, data);
    }

    const serialized = await this.serializeConnection({
      ...data,
      id: data.id ?? id,
      status: "active",
      created_at: now,
      updated_at: now,
    });
    await this.db
      .insertInto("connections")
      .values(serialized as Insertable<Database["connections"]>)
      .execute();

    const connection = await this.findById(id);
    if (!connection) {
      throw new Error(`Failed to create connection with id: ${id}`);
    }

    return connection;
  }

  async findById(
    id: string,
    organizationId?: string,
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
    return row ? this.deserializeConnection(row as RawConnectionRow) : null;
  }

  async list(
    organizationId: string,
    options?: { includeVirtual?: boolean },
  ): Promise<ConnectionEntity[]> {
    let query = this.db
      .selectFrom("connections")
      .selectAll()
      .where("organization_id", "=", organizationId);

    // By default, exclude VIRTUAL connections unless explicitly requested
    if (!options?.includeVirtual) {
      query = query.where("connection_type", "!=", "VIRTUAL");
    }

    const rows = await query.execute();

    return Promise.all(
      rows.map((row) => this.deserializeConnection(row as RawConnectionRow)),
    );
  }

  async update(
    id: string,
    data: Partial<ConnectionEntity>,
  ): Promise<ConnectionEntity> {
    if (Object.keys(data).length === 0) {
      const connection = await this.findById(id);
      if (!connection) throw new Error("Connection not found");
      return connection;
    }

    const serialized = await this.serializeConnection({
      ...data,
      updated_at: new Date().toISOString(),
    });

    await this.db
      .updateTable("connections")
      .set(serialized)
      .where("id", "=", id)
      .execute();

    const connection = await this.findById(id);
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
    const connection = await this.findById(id);
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
        console.error("Failed to decrypt connection token:", error);
      }
    }

    // Decrypt configuration state
    let decryptedConfigState: Record<string, unknown> | null = null;
    if (row.configuration_state) {
      try {
        const decryptedJson = await this.vault.decrypt(row.configuration_state);
        decryptedConfigState = JSON.parse(decryptedJson);
      } catch (error) {
        console.error("Failed to decrypt configuration state:", error);
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
        console.error("Failed to parse connection_headers:", error);
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
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }
}
