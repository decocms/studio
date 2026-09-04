import type { Kysely } from "kysely";
import { sql } from "kysely";
import {
  type GitProviderKind,
  type RepoRef,
  type Repository,
  repoWebUrl,
} from "@decocms/shared/git-providers";
import type { Database } from "./types";

/**
 * `repositories` (migration 199): first-class repos, one row per
 * (org, host, path) case-insensitively. Every org-facing method takes the
 * organizationId in the WHERE clause — tenancy by construction.
 */

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

type Row = {
  id: string;
  organization_id: string;
  account_id: string | null;
  provider: GitProviderKind;
  host: string;
  path: string;
  external_id: string | null;
  default_branch: string | null;
  web_url: string;
  visibility: "public" | "private" | "internal" | null;
  legacy_connection_id: string | null;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

/** Entity plus the server-only bridge to a legacy repo-scoped connection. */
export interface RepositoryRecord extends Repository {
  legacyConnectionId: string | null;
}

function toEntity(row: Row): RepositoryRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    accountId: row.account_id,
    provider: row.provider,
    host: row.host,
    path: row.path,
    externalId: row.external_id,
    defaultBranch: row.default_branch,
    webUrl: row.web_url,
    visibility: row.visibility,
    legacyConnectionId: row.legacy_connection_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function repoRefOf(repo: Repository): RepoRef {
  return { provider: repo.provider, host: repo.host, path: repo.path };
}

export interface UpsertRepositoryParams {
  organizationId: string;
  ref: RepoRef;
  accountId?: string | null;
  externalId?: string | null;
  defaultBranch?: string | null;
  visibility?: "public" | "private" | "internal" | null;
  legacyConnectionId?: string | null;
  createdBy?: string | null;
}

export class RepositoryStorage {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Insert, or refresh the existing row for the same repo. Provider facts
   * (external id, default branch, visibility) are overwritten when given;
   * `accountId` is only overwritten when given, so linking a public clone to
   * an account later is a plain re-upsert with the account.
   */
  async upsert(params: UpsertRepositoryParams): Promise<RepositoryRecord> {
    const host = params.ref.host.toLowerCase();
    const existing = await this.findByRef(params.organizationId, params.ref);
    if (existing) {
      const row = await this.db
        .updateTable("repositories")
        .set({
          path: params.ref.path,
          provider: params.ref.provider,
          web_url: repoWebUrl({ ...params.ref, host }),
          ...(params.accountId !== undefined
            ? { account_id: params.accountId }
            : {}),
          ...(params.externalId !== undefined
            ? { external_id: params.externalId }
            : {}),
          ...(params.defaultBranch !== undefined
            ? { default_branch: params.defaultBranch }
            : {}),
          ...(params.visibility !== undefined
            ? { visibility: params.visibility }
            : {}),
          ...(params.legacyConnectionId !== undefined
            ? { legacy_connection_id: params.legacyConnectionId }
            : {}),
          updated_at: new Date(),
        })
        .where("id", "=", existing.id)
        .where("organization_id", "=", params.organizationId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return toEntity(row as Row);
    }
    const row = await this.db
      .insertInto("repositories")
      .values({
        organization_id: params.organizationId,
        account_id: params.accountId ?? null,
        provider: params.ref.provider,
        host,
        path: params.ref.path,
        external_id: params.externalId ?? null,
        default_branch: params.defaultBranch ?? null,
        web_url: repoWebUrl({ ...params.ref, host }),
        visibility: params.visibility ?? null,
        legacy_connection_id: params.legacyConnectionId ?? null,
        created_by: params.createdBy ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toEntity(row as Row);
  }

  async get(
    id: string,
    organizationId: string,
  ): Promise<RepositoryRecord | null> {
    const row = await this.db
      .selectFrom("repositories")
      .selectAll()
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    return row ? toEntity(row as Row) : null;
  }

  /** Cross-org read for background paths (sandbox re-mint) that hold the id. */
  async getUnscoped(id: string): Promise<RepositoryRecord | null> {
    const row = await this.db
      .selectFrom("repositories")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? toEntity(row as Row) : null;
  }

  async findByRef(
    organizationId: string,
    ref: Pick<RepoRef, "host" | "path">,
  ): Promise<RepositoryRecord | null> {
    const row = await this.db
      .selectFrom("repositories")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("host", "=", ref.host.toLowerCase())
      .where(sql`lower(path)`, "=", ref.path.toLowerCase())
      .executeTakeFirst();
    return row ? toEntity(row as Row) : null;
  }

  async listByOrg(
    organizationId: string,
    filter?: { accountId?: string },
  ): Promise<RepositoryRecord[]> {
    let q = this.db
      .selectFrom("repositories")
      .selectAll()
      .where("organization_id", "=", organizationId);
    if (filter?.accountId) q = q.where("account_id", "=", filter.accountId);
    const rows = await q.orderBy("path", "asc").execute();
    return (rows as Row[]).map(toEntity);
  }

  async delete(id: string, organizationId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("repositories")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }
}
