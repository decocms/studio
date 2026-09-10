import { sql, type Kysely } from "kysely";
import type {
  GitAuthKind,
  GitProviderAccount,
  GitProviderKind,
} from "@decocms/shared/git-providers";
import type { Database } from "./types";

/**
 * `git_provider_accounts` (migration 204): the credential holder behind every
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
  installation_authorized_by: string | null;
  installation_repository_ids: number[] | null;
  credential_connection_id: string | null;
  status: "active" | "revoked";
  created_by: string | null;
  connected_by_name?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

/** Entity plus the server-only bridge to a legacy `mcp-github` connection. */
export interface GitProviderAccountRecord extends GitProviderAccount {
  credentialConnectionId: string | null;
  connectedBy: { name: string } | null;
  installationAuthorizedBy: string | null;
  /** Null grants the whole installation; a list grants only those repositories. */
  installationRepositoryIds: number[] | null;
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
    installationAuthorizedBy: row.installation_authorized_by ?? null,
    installationRepositoryIds: row.installation_repository_ids ?? null,
    credentialConnectionId: row.credential_connection_id,
    connectedBy: row.connected_by_name ? { name: row.connected_by_name } : null,
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
  installationAuthorizedBy?: string | null;
  installationRepositoryIds?: number[] | null;
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
        installation_authorized_by: params.installationAuthorizedBy ?? null,
        installation_repository_ids: params.installationRepositoryIds
          ? JSON.stringify(params.installationRepositoryIds)
          : null,
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
            installation_authorized_by: params.installationAuthorizedBy ?? null,
            // Grants add up: a second person who administers other
            // repositories widens what this organization can reach, and an
            // owner connecting the account widens it to everything. A row
            // that was revoked or never authorized starts over from the
            // incoming grant instead of reviving the old one.
            installation_repository_ids: sql<string | null>`CASE
              WHEN git_provider_accounts.status != 'active'
                OR git_provider_accounts.installation_authorized_by IS NULL
                THEN excluded.installation_repository_ids
              WHEN excluded.installation_repository_ids IS NULL
                OR git_provider_accounts.installation_repository_ids IS NULL THEN NULL
              ELSE (SELECT jsonb_agg(DISTINCT value) FROM jsonb_array_elements(
                git_provider_accounts.installation_repository_ids || excluded.installation_repository_ids
              )) END`,
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
      .leftJoin(
        "user as connector",
        "connector.id",
        "git_provider_accounts.created_by",
      )
      .selectAll("git_provider_accounts")
      .select("connector.name as connected_by_name")
      .where("git_provider_accounts.organization_id", "=", organizationId)
      .orderBy("git_provider_accounts.created_at", "asc")
      .execute();
    return rows.map(toEntity);
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
