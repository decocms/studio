import type { Kysely } from "kysely";
import type { CredentialVault } from "../encryption/credential-vault";
import type { DownstreamTokenData } from "./downstream-token";
import type {
  Database,
  DownstreamToken,
  GitProviderAccountCredentialTable,
} from "./types";

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
    return decryptGitProviderAccountCredentialRow(this.vault, row);
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

/**
 * Row shape as read back from `git_provider_account_credentials`, before
 * decryption.
 */
export type RawGitProviderAccountCredentialRow = Pick<
  GitProviderAccountCredentialTable,
  | "access_token"
  | "refresh_token"
  | "scope"
  | "client_id"
  | "client_secret"
  | "token_endpoint"
> & {
  account_id: string;
  expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

/**
 * Decrypt sensitive fields from a `git_provider_account_credentials` row.
 * Mirrors `decryptDownstreamTokenRow`: corrupted ciphertext (a tampered
 * value, or a row encrypted under a vault key that has since been rotated)
 * makes AES-GCM's tag check throw — that must not crash the caller. Callers
 * already treat a missing row as "no cached credential, go re-authorize"; an
 * undecryptable row degrades to the same outcome instead of a 500.
 */
export async function decryptGitProviderAccountCredentialRow(
  vault: CredentialVault,
  row: RawGitProviderAccountCredentialRow,
): Promise<DownstreamToken | null> {
  try {
    const accessToken = await vault.decrypt(row.access_token);
    const refreshToken = row.refresh_token
      ? await vault.decrypt(row.refresh_token)
      : null;
    const clientSecret = row.client_secret
      ? await vault.decrypt(row.client_secret)
      : null;
    return {
      id: row.account_id,
      connectionId: row.account_id,
      accessToken,
      refreshToken,
      scope: row.scope,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      clientId: row.client_id,
      clientSecret,
      tokenEndpoint: row.token_endpoint,
    };
  } catch (error) {
    console.warn(
      "[GitProviderAccountCredential] failed to decrypt credential row",
      {
        accountId: row.account_id,
        message: error instanceof Error ? error.message : String(error),
      },
    );
    return null;
  }
}
