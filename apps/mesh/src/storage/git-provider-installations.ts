import type { Kysely } from "kysely";
import type { Database, GitProviderInstallationInfo } from "./types";
import { generatePrefixedId } from "@/shared/utils/generate-id";

/**
 * Storage for Git Provider installations.
 *
 * An installation row records "this Studio org has installed Decobot on this
 * GitHub account (org or user) with these repository permissions". No secrets
 * are stored here — installation access tokens are short-lived (1h) and minted
 * on demand by the GitHub adapter from the Decobot App's private key (env).
 *
 * Compared with `AIProviderKeyStorage`, there is no `encrypted_*` column and
 * therefore no `resolve()`/vault call: the only secret in this subsystem is
 * the Decobot App private key, which lives in the env and is read by the
 * adapter directly.
 */
export class GitProviderInstallationStorage {
  constructor(private db: Kysely<Database>) {}

  private rowToInfo(row: {
    id: string;
    organization_id: string;
    provider_id: string;
    installation_id: string;
    account_login: string;
    account_id: string;
    account_type: string;
    repository_selection: string;
    created_by: string;
    created_at: Date | string;
    updated_at: Date | string;
  }): GitProviderInstallationInfo {
    const accountType =
      row.account_type === "Organization" ? "Organization" : "User";
    const repoSelection =
      row.repository_selection === "all" ? "all" : "selected";
    return {
      id: row.id,
      providerId: row.provider_id,
      installationId: row.installation_id,
      accountLogin: row.account_login,
      accountId: row.account_id,
      accountType,
      repositorySelection: repoSelection,
      organizationId: row.organization_id,
      createdBy: row.created_by,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
      updatedAt:
        row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : String(row.updated_at),
    };
  }

  /**
   * Insert or update an installation. Idempotent on
   * (organization_id, provider_id, installation_id) so re-running the install
   * callback for the same installation refreshes account metadata instead of
   * exploding on the unique constraint.
   */
  async upsert(params: {
    providerId: string;
    installationId: string;
    accountLogin: string;
    accountId: string;
    accountType: "Organization" | "User";
    repositorySelection: "all" | "selected";
    organizationId: string;
    createdBy: string;
  }): Promise<GitProviderInstallationInfo> {
    const id = generatePrefixedId("gpi");
    const now = new Date();

    const row = await this.db
      .insertInto("git_provider_installations")
      .values({
        id,
        organization_id: params.organizationId,
        provider_id: params.providerId,
        installation_id: params.installationId,
        account_login: params.accountLogin,
        account_id: params.accountId,
        account_type: params.accountType,
        repository_selection: params.repositorySelection,
        created_by: params.createdBy,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc
          .columns(["organization_id", "provider_id", "installation_id"])
          .doUpdateSet({
            account_login: params.accountLogin,
            account_id: params.accountId,
            account_type: params.accountType,
            repository_selection: params.repositorySelection,
            updated_at: now,
          }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.rowToInfo(row);
  }

  async list(params: {
    organizationId: string;
    providerId?: string;
  }): Promise<GitProviderInstallationInfo[]> {
    let query = this.db
      .selectFrom("git_provider_installations")
      .where("organization_id", "=", params.organizationId)
      .selectAll();
    if (params.providerId) {
      query = query.where("provider_id", "=", params.providerId);
    }
    const rows = await query.orderBy("created_at", "desc").execute();
    return rows.map((row) => this.rowToInfo(row));
  }

  /**
   * Find an installation in this org that owns repos under `accountLogin`.
   * GitHub account logins are case-insensitive — we match case-insensitively
   * so a tool can call `findByOrgAndOwner(orgId, "deco-CX")` and still resolve.
   */
  async findByOrgAndOwner(
    organizationId: string,
    providerId: string,
    accountLogin: string,
  ): Promise<GitProviderInstallationInfo | undefined> {
    const rows = await this.db
      .selectFrom("git_provider_installations")
      .where("organization_id", "=", organizationId)
      .where("provider_id", "=", providerId)
      .selectAll()
      .execute();
    const needle = accountLogin.toLowerCase();
    const match = rows.find((r) => r.account_login.toLowerCase() === needle);
    return match ? this.rowToInfo(match) : undefined;
  }

  async findById(
    id: string,
    organizationId: string,
  ): Promise<GitProviderInstallationInfo | undefined> {
    const row = await this.db
      .selectFrom("git_provider_installations")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .selectAll()
      .executeTakeFirst();
    return row ? this.rowToInfo(row) : undefined;
  }

  async delete(id: string, organizationId: string): Promise<void> {
    const result = await this.db
      .deleteFrom("git_provider_installations")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    if (!result.numDeletedRows) {
      throw new Error(`Git provider installation ${id} not found`);
    }
  }
}
