/**
 * Downstream Token Storage Implementation
 *
 * Handles CRUD operations for downstream MCP OAuth tokens.
 * Supports token caching and refresh for OAuth-enabled MCP connections.
 */

import type { Kysely } from "kysely";
import type { CredentialVault } from "../encryption/credential-vault";
import type { Database, DownstreamToken } from "./types";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";

/**
 * Data for creating/updating a downstream token
 */
export interface DownstreamTokenData {
  connectionId: string;
  accessToken: string;
  refreshToken: string | null;
  scope: string | null;
  expiresAt: Date | null;
  // Dynamic Client Registration info
  clientId: string | null;
  clientSecret: string | null;
  tokenEndpoint: string | null;
}

/**
 * Downstream Token Storage Implementation
 */
export class DownstreamTokenStorage {
  constructor(
    private db: Kysely<Database>,
    private vault: CredentialVault,
  ) {}

  async get(connectionId: string): Promise<DownstreamToken | null> {
    const row = await this.db
      .selectFrom("downstream_tokens")
      .selectAll()
      .where("connectionId", "=", connectionId)
      .executeTakeFirst();

    if (!row) return null;

    return this.decryptToken(row);
  }

  async upsert(data: DownstreamTokenData): Promise<DownstreamToken> {
    const now = new Date().toISOString();

    // Encrypt sensitive fields
    const encryptedAccessToken = await this.vault.encrypt(data.accessToken);
    const encryptedRefreshToken = data.refreshToken
      ? await this.vault.encrypt(data.refreshToken)
      : null;
    const encryptedClientSecret = data.clientSecret
      ? await this.vault.encrypt(data.clientSecret)
      : null;

    // Use transaction to prevent race conditions during upsert
    return await this.db.transaction().execute(async (trx) => {
      // Check for existing token within transaction
      const existing = await trx
        .selectFrom("downstream_tokens")
        .select(["id", "createdAt"])
        .where("connectionId", "=", data.connectionId)
        .executeTakeFirst();

      if (existing) {
        // Update existing token
        await trx
          .updateTable("downstream_tokens")
          .set({
            accessToken: encryptedAccessToken,
            refreshToken: encryptedRefreshToken,
            scope: data.scope,
            expiresAt: data.expiresAt?.toISOString() ?? null,
            clientId: data.clientId,
            clientSecret: encryptedClientSecret,
            tokenEndpoint: data.tokenEndpoint,
            updatedAt: now,
          })
          .where("id", "=", existing.id)
          .execute();

        return {
          id: existing.id,
          connectionId: data.connectionId,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          scope: data.scope,
          expiresAt: data.expiresAt,
          createdAt: existing.createdAt as unknown as string,
          updatedAt: now,
          clientId: data.clientId,
          clientSecret: data.clientSecret,
          tokenEndpoint: data.tokenEndpoint,
        };
      }

      // Create new token
      const id = generatePrefixedId("dtok");

      await trx
        .insertInto("downstream_tokens")
        .values({
          id,
          connectionId: data.connectionId,
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken,
          scope: data.scope,
          expiresAt: data.expiresAt?.toISOString() ?? null,
          clientId: data.clientId,
          clientSecret: encryptedClientSecret,
          tokenEndpoint: data.tokenEndpoint,
          createdAt: now as unknown as string,
          updatedAt: now as unknown as string,
        })
        .execute();

      return {
        id,
        connectionId: data.connectionId,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        scope: data.scope,
        expiresAt: data.expiresAt,
        createdAt: now as unknown as string,
        updatedAt: now as unknown as string,
        clientId: data.clientId,
        clientSecret: data.clientSecret,
        tokenEndpoint: data.tokenEndpoint,
      };
    });
  }

  async delete(connectionId: string): Promise<void> {
    await this.db
      .deleteFrom("downstream_tokens")
      .where("connectionId", "=", connectionId)
      .execute();
  }

  /**
   * Check if token is expired or will expire within buffer time.
   *
   * Note: the default buffer is 0 (actual expiry). Callers that can refresh
   * should pass a buffer (e.g. 5 minutes) to refresh proactively.
   */
  isExpired(token: DownstreamToken, bufferMs: number = 0): boolean {
    if (!token.expiresAt) {
      // No expiry = never expires
      return false;
    }

    const expiresAt =
      token.expiresAt instanceof Date
        ? token.expiresAt
        : new Date(token.expiresAt);

    const expiryTime = expiresAt.getTime();
    if (Number.isNaN(expiryTime)) {
      // Fail-safe: if date is invalid, treat as expired
      return true;
    }

    return expiryTime - bufferMs < Date.now();
  }

  /**
   * Decrypt sensitive fields from a database row
   */
  private async decryptToken(row: {
    id: string;
    connectionId: string;
    accessToken: string;
    refreshToken: string | null;
    scope: string | null;
    expiresAt: Date | string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
    clientId: string | null;
    clientSecret: string | null;
    tokenEndpoint: string | null;
  }): Promise<DownstreamToken> {
    const accessToken = await this.vault.decrypt(row.accessToken);
    const refreshToken = row.refreshToken
      ? await this.vault.decrypt(row.refreshToken)
      : null;
    const clientSecret = row.clientSecret
      ? await this.vault.decrypt(row.clientSecret)
      : null;

    return {
      id: row.id,
      connectionId: row.connectionId,
      accessToken,
      refreshToken,
      scope: row.scope,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      clientId: row.clientId,
      clientSecret,
      tokenEndpoint: row.tokenEndpoint,
    };
  }
}
