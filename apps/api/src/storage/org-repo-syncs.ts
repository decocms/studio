import type { Kysely } from "kysely";
import type { Database, OrgRepoSync } from "./types";

/**
 * Per-org GitHub repo → volume sync configs (see migration 168). Every
 * org-facing method takes the organizationId in the WHERE clause — tenancy by
 * construction. `listEnabled()` (all orgs) exists only for the sync cron.
 */

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

type Row = {
  id: string;
  organization_id: string;
  connection_id: string | null;
  repository_id: string | null;
  repository_path?: string | null;
  repo_owner: string;
  repo_name: string;
  ref: string;
  paths: Array<{ from: string; to?: string }>;
  volume: string;
  enabled: boolean;
  last_synced_at: Date | string | null;
  last_sync_error: string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
};

function toEntity(row: Row): OrgRepoSync {
  const segments = row.repository_path?.split("/");
  return {
    id: row.id,
    organizationId: row.organization_id,
    connectionId: row.connection_id,
    repositoryId: row.repository_id,
    repoOwner: segments ? segments.slice(0, -1).join("/") : row.repo_owner,
    repoName: segments?.at(-1) ?? row.repo_name,
    ref: row.ref,
    paths: row.paths,
    volume: row.volume,
    enabled: row.enabled,
    lastSyncedAt: row.last_synced_at ? toIso(row.last_synced_at) : null,
    lastSyncError: row.last_sync_error,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export class OrgRepoSyncStorage {
  constructor(private readonly db: Kysely<Database>) {}

  private configs() {
    return this.db
      .selectFrom("org_repo_sync")
      .leftJoin("repositories as repository", (join) =>
        join
          .onRef("repository.id", "=", "org_repo_sync.repository_id")
          .onRef(
            "repository.organization_id",
            "=",
            "org_repo_sync.organization_id",
          ),
      )
      .selectAll("org_repo_sync")
      .select("repository.path as repository_path");
  }

  async create(params: {
    organizationId: string;
    /** At least one of `connectionId` / `repositoryId` must be set — the
     *  `org_repo_sync_source_present` CHECK enforces it in the database. */
    connectionId?: string | null;
    repositoryId?: string | null;
    repoOwner: string;
    repoName: string;
    ref: string;
    paths: Array<{ from: string; to?: string }>;
    volume: string;
    createdBy: string;
  }): Promise<OrgRepoSync> {
    const row = await this.db
      .insertInto("org_repo_sync")
      .values({
        organization_id: params.organizationId,
        connection_id: params.connectionId ?? null,
        repository_id: params.repositoryId ?? null,
        repo_owner: params.repoOwner,
        repo_name: params.repoName,
        ref: params.ref,
        paths: JSON.stringify(params.paths),
        volume: params.volume,
        created_by: params.createdBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toEntity(row as Row);
  }

  async get(id: string, organizationId: string): Promise<OrgRepoSync | null> {
    const row = await this.configs()
      .where("org_repo_sync.id", "=", id)
      .where("org_repo_sync.organization_id", "=", organizationId)
      .executeTakeFirst();
    return row ? toEntity(row as Row) : null;
  }

  async listByOrg(organizationId: string): Promise<OrgRepoSync[]> {
    const rows = await this.configs()
      .where("org_repo_sync.organization_id", "=", organizationId)
      .orderBy("org_repo_sync.created_at", "asc")
      .execute();
    return (rows as Row[]).map(toEntity);
  }

  async countByOrg(organizationId: string): Promise<number> {
    const row = await this.db
      .selectFrom("org_repo_sync")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("organization_id", "=", organizationId)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /** Every enabled config across all orgs — the sync cron's work list. */
  async listEnabled(): Promise<OrgRepoSync[]> {
    const rows = await this.configs()
      .where("enabled", "=", true)
      .orderBy("org_repo_sync.created_at", "asc")
      .execute();
    return (rows as Row[]).map(toEntity);
  }

  /** Enabled volume names for one org — mounts and the skill catalog. */
  async listEnabledVolumes(organizationId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("org_repo_sync")
      .select("volume")
      .where("organization_id", "=", organizationId)
      .where("enabled", "=", true)
      .orderBy("volume", "asc")
      .execute();
    return rows.map((r) => r.volume);
  }

  /** Whether a volume is owned by any sync config (enabled or paused) —
   *  the fs write route rejects direct writes into mirror targets. Hits the
   *  UNIQUE (organization_id, volume) index. */
  async isSyncVolume(organizationId: string, volume: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("org_repo_sync")
      .select("id")
      .where("organization_id", "=", organizationId)
      .where("volume", "=", volume)
      .executeTakeFirst();
    return row !== undefined;
  }

  async update(
    id: string,
    organizationId: string,
    patch: {
      enabled?: boolean;
      ref?: string;
      paths?: Array<{ from: string; to?: string }>;
    },
  ): Promise<OrgRepoSync | null> {
    const row = await this.db
      .updateTable("org_repo_sync")
      .set({
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.ref !== undefined ? { ref: patch.ref } : {}),
        ...(patch.paths !== undefined
          ? { paths: JSON.stringify(patch.paths) }
          : {}),
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .returningAll()
      .executeTakeFirst();
    return row ? toEntity(row as Row) : null;
  }

  async delete(id: string, organizationId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("org_repo_sync")
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /** Record a sync outcome: null error = success. */
  async recordSyncResult(
    id: string,
    result: { error: string | null },
  ): Promise<void> {
    await this.db
      .updateTable("org_repo_sync")
      .set({
        last_synced_at: new Date(),
        last_sync_error: result.error,
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .execute();
  }
}
