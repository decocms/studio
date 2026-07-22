/**
 * Trigger Callback Tokens Storage
 *
 * Manages opaque callback tokens that external MCPs use to authenticate
 * trigger callbacks to Studio. Tokens are stored as SHA-256 hashes;
 * plaintext is only returned once at creation time.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "./types";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export interface TokenPair {
  plaintext: string;
  hash: string;
}

export interface TriggerCallbackTokenStorage {
  /**
   * Generate a token pair (plaintext + hash) without persisting.
   * Use with persistTokenHash() for two-phase token creation.
   */
  generateTokenPair(): Promise<TokenPair>;

  /**
   * Persist a token hash for a connection+organization pair.
   * Upserts — safe for concurrent calls.
   */
  persistTokenHash(
    organizationId: string,
    connectionId: string,
    tokenHash: string,
  ): Promise<void>;

  /**
   * Create or rotate a callback token for a connection+organization pair.
   * Returns the plaintext token (only available at creation time).
   * Convenience method that combines generateTokenPair + persistTokenHash.
   */
  createOrRotateToken(
    organizationId: string,
    connectionId: string,
  ): Promise<string>;

  /**
   * Validate a callback token.
   * Returns connection and org context if valid, null otherwise.
   */
  validateToken(
    token: string,
  ): Promise<{ organizationId: string; connectionId: string } | null>;

  /**
   * Delete callback token for a connection+organization pair.
   */
  deleteByConnection(
    connectionId: string,
    organizationId: string,
  ): Promise<void>;
}

export class KyselyTriggerCallbackTokenStorage
  implements TriggerCallbackTokenStorage
{
  constructor(private db: Kysely<Database>) {}

  async generateTokenPair(): Promise<TokenPair> {
    const plaintext = generateToken();
    const hash = await hashToken(plaintext);
    return { plaintext, hash };
  }

  async persistTokenHash(
    organizationId: string,
    connectionId: string,
    tokenHash: string,
  ): Promise<void> {
    const id = crypto.randomUUID();
    await this.db
      .insertInto("trigger_callback_tokens")
      .values({
        id,
        organization_id: organizationId,
        connection_id: connectionId,
        token_hash: tokenHash,
        created_at: new Date().toISOString(),
      })
      .onConflict((oc) =>
        oc.columns(["connection_id", "organization_id"]).doUpdateSet({
          id,
          token_hash: tokenHash,
        }),
      )
      .execute();
  }

  async createOrRotateToken(
    organizationId: string,
    connectionId: string,
  ): Promise<string> {
    const { plaintext, hash } = await this.generateTokenPair();
    await this.persistTokenHash(organizationId, connectionId, hash);
    return plaintext;
  }

  async validateToken(
    token: string,
  ): Promise<{ organizationId: string; connectionId: string } | null> {
    const tokenHash = await hashToken(token);

    const row = await this.db
      .selectFrom("trigger_callback_tokens")
      .select(["organization_id", "connection_id"])
      .where("token_hash", "=", tokenHash)
      .executeTakeFirst();

    if (!row) return null;

    return {
      organizationId: row.organization_id,
      connectionId: row.connection_id,
    };
  }

  async deleteByConnection(
    connectionId: string,
    organizationId: string,
  ): Promise<void> {
    await this.db
      .deleteFrom("trigger_callback_tokens")
      .where("connection_id", "=", connectionId)
      .where("organization_id", "=", organizationId)
      .execute();
  }
}
