import type { Kysely } from "kysely";
import type {
  GitAuthKind,
  GitProviderAccount,
  GitProviderKind,
} from "@decocms/shared/git-providers";
import type { Database } from "./types";

/**
 * `git_provider_accounts` (migration 199): the credential holder behind every
 * first-class repository. Every org-facing method takes the organizationId in
 * the WHERE clause — tenancy by construction.
 */

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

type Row = {
  id: string;
  organization_id: string;
  type: GitProviderKind;
  host: string;
  auth_kind: GitAuthKind;
  external_account_id: string;
  login: string;
  avatar_url: string | null;
  installation_id: string | number | null;
  credential_connection_id: string | null;
  status: "active" | "revoked";
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

/** Entity plus the server-only bridge to a legacy `mcp-github` connection. */
export interface GitProviderAccountRecord extends GitProviderAccount {
  credentialConnectionId: string | null;
}

function toEntity(row: Row): GitProviderAccountRecord {
  const installationId =
    row.installation_id === null || row.installation_id === undefined
      ? null
      : Number(row.installation_id);
  return {
    id: row.id,
    organizationId: row.organization_id,
    type: row.type,
    host: row.host,
    authKind: row.auth_kind,
    externalAccountId: row.external_account_id,
    login: row.login,
    avatarUrl: row.avatar_url,
    installationId: Number.isFinite(installationId) ? installationId : null,
    status: row.status,
    credentialConnectionId: row.credential_connection_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export interface UpsertGitProviderAccountParams {
  organizationId: string;
  type: GitProviderKind;
  host: string;
  authKind: GitAuthKind;
  externalAccountId: string;
  login: string;
  avatarUrl?: string | null;
  installationId?: number | null;
  createdBy?: string | null;
}

export class GitProviderAccountStorage {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Insert or refresh the account identified by (org, host, external id).
   * Re-connecting the same installation/user updates login/avatar, revives a
   * `revoked` row and drops the legacy connection bridge: from now on the
   * account authenticates through Studio's own credentials.
   */
  async upsert(
    params: UpsertGitProviderAccountParams,
  ): Promise<GitProviderAccountRecord> {
    const now = new Date();
    const row = await this.db
      .insertInto("git_provider_accounts")
      .values({
        organization_id: params.organizationId,
        type: params.type,
        host: params.host.toLowerCase(),
        auth_kind: params.authKind,
        external_account_id: params.externalAccountId,
        login: params.login,
        avatar_url: params.avatarUrl ?? null,
        installation_id: params.installationId ?? null,
        credential_connection_id: null,
        status: "active",
        created_by: params.createdBy ?? null,
      })
      .onConflict((oc) =>
        oc
          .columns(["organization_id", "host", "external_account_id"])
          .doUpdateSet({
            type: params.type,
            auth_kind: params.authKind,
            login: params.login,
            avatar_url: params.avatarUrl ?? null,
            installation_id: params.installationId ?? null,
            credential_connection_id: null,
            status: "active",
            updated_at: now,
          }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return toEntity(row as Row);
  }

  async get(
    id: string,
    organizationId: string,
  ): Promise<GitProviderAccountRecord | null> {
    const row = await this.db
      .selectFrom("git_provider_accounts")
      .selectAll()
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    return row ? toEntity(row as Row) : null;
  }

  /** Cross-org read for background paths that already hold a repository row. */
  async getUnscoped(id: string): Promise<GitProviderAccountRecord | null> {
    const row = await this.db
      .selectFrom("git_provider_accounts")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? toEntity(row as Row) : null;
  }

  async listByOrg(organizationId: string): Promise<GitProviderAccountRecord[]> {
    const rows = await this.db
      .selectFrom("git_provider_accounts")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .orderBy("created_at", "asc")
      .execute();
    return (rows as Row[]).map(toEntity);
  }

  async findByExternalId(params: {
    organizationId: string;
    host: string;
    externalAccountId: string;
  }): Promise<GitProviderAccountRecord | null> {
    const row = await this.db
      .selectFrom("git_provider_accounts")
      .selectAll()
      .where("organization_id", "=", params.organizationId)
      .where("host", "=", params.host.toLowerCase())
      .where("external_account_id", "=", params.externalAccountId)
      .executeTakeFirst();
    return row ? toEntity(row as Row) : null;
  }

  async setStatus(
    id: string,
    organizationId: string,
    status: "active" | "revoked",
  ): Promise<void> {
    await this.db
      .updateTable("git_provider_accounts")
      .set({ status, updated_at: new Date() })
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .execute();
  }

  /** Repositories keep their row (`account_id` → NULL) and become anonymous clones. */
  async delete(id: string, organizationId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("git_provider_accounts")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }
}
