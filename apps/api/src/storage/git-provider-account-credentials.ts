import type { Kysely } from "kysely";
import type { CredentialVault } from "../encryption/credential-vault";
import type { DownstreamTokenData } from "./downstream-token";
import type { Database, DownstreamToken } from "./types";

/**
 * `git_provider_account_credentials` (migration 199): the OAuth grant or
 * long-lived token of an `oauth` / `token` git provider account. Same
 * encrypted columns and the same `OAuthGrantStore` surface as
 * `DownstreamTokenStorage`, so `getValidDownstreamAccessToken` /
 * `refreshAndStore` work unchanged — here `DownstreamToken.connectionId`
 * carries the account id.
 */
export class GitProviderAccountCredentialStorage {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly vault: CredentialVault,
  ) {}

  async get(accountId: string): Promise<DownstreamToken | null> {
    const row = await this.db
      .selectFrom("git_provider_account_credentials")
      .selectAll()
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      id: row.account_id,
      connectionId: row.account_id,
      accessToken: await this.vault.decrypt(row.access_token),
      refreshToken: row.refresh_token
        ? await this.vault.decrypt(row.refresh_token)
        : null,
      scope: row.scope,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      clientId: row.client_id,
      clientSecret: row.client_secret
        ? await this.vault.decrypt(row.client_secret)
        : null,
      tokenEndpoint: row.token_endpoint,
    };
  }

  /** `data.connectionId` is the account id (see module doc). */
  async upsert(data: DownstreamTokenData): Promise<void> {
    const now = new Date();
    const accessToken = await this.vault.encrypt(data.accessToken);
    const refreshToken = data.refreshToken
      ? await this.vault.encrypt(data.refreshToken)
      : null;
    const clientSecret = data.clientSecret
      ? await this.vault.encrypt(data.clientSecret)
      : null;
    await this.db
      .insertInto("git_provider_account_credentials")
      .values({
        account_id: data.connectionId,
        access_token: accessToken,
        refresh_token: refreshToken,
        scope: data.scope,
        expires_at: data.expiresAt,
        client_id: data.clientId,
        client_secret: clientSecret,
        token_endpoint: data.tokenEndpoint,
      })
      .onConflict((oc) =>
        oc.column("account_id").doUpdateSet({
          access_token: accessToken,
          refresh_token: refreshToken,
          scope: data.scope,
          expires_at: data.expiresAt,
          client_id: data.clientId,
          client_secret: clientSecret,
          token_endpoint: data.tokenEndpoint,
          updated_at: now,
        }),
      )
      .execute();
  }

  async delete(accountId: string): Promise<void> {
    await this.db
      .deleteFrom("git_provider_account_credentials")
      .where("account_id", "=", accountId)
      .execute();
  }

  /** Mirrors `DownstreamTokenStorage.isExpired`: null expiry never expires. */
  isExpired(token: DownstreamToken, bufferMs: number = 0): boolean {
    if (!token.expiresAt) return false;
    const expiresAt =
      token.expiresAt instanceof Date
        ? token.expiresAt
        : new Date(token.expiresAt);
    const expiryTime = expiresAt.getTime();
    if (Number.isNaN(expiryTime)) return true;
    return expiryTime - bufferMs < Date.now();
  }
}
