import { type Kysely, sql } from "kysely";
import type { RepositoryBrief } from "@/repo-upkeep/brief";
import type { Database } from "./types";

export interface RepositoryBriefRecord {
  repositoryId: string;
  organizationId: string;
  headSha: string | null;
  brief: RepositoryBrief | null;
  builtAt: Date | null;
  attemptedAt: Date;
  error: string | null;
}

export interface DueRepository {
  organizationId: string;
  repositoryId: string;
}

/**
 * Repository briefs (migration 254). A failure only moves `attempted_at` and
 * sets `error`; it never touches a good brief.
 */
export class RepositoryBriefStorage {
  constructor(private db: Kysely<Database>) {}

  /**
   * Repositories bound to a project in an org with `repo_upkeep` on, whose
   * last good brief is older than `staleBefore` (or missing) and whose last
   * attempt is older than `retryBefore`. Never-attempted first, then oldest.
   *
   * The flag is read in SQL so orgs with it off cannot crowd the cap; `= 'true'`
   * matches `orgFlagEnabled` for a default-off flag.
   */
  async listDue(
    staleBefore: Date,
    retryBefore: Date,
    limit: number,
  ): Promise<DueRepository[]> {
    const rows = await this.db
      .selectFrom("repositories as r")
      .innerJoin(
        "organization_settings as s",
        "s.organizationId",
        "r.organization_id",
      )
      .leftJoin("repository_briefs as b", "b.repository_id", "r.id")
      .select(["r.id as repositoryId", "r.organization_id as organizationId"])
      .where(sql<boolean>`s.flags->>'repo_upkeep' = 'true'`)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("connections as c")
            .select("c.id")
            .whereRef("c.repository_id", "=", "r.id")
            .whereRef("c.organization_id", "=", "r.organization_id")
            .where("c.connection_type", "=", "VIRTUAL"),
        ),
      )
      .where((eb) =>
        eb.or([
          eb("b.repository_id", "is", null),
          eb.and([
            eb(
              sql`coalesce(b.built_at, '-infinity'::timestamptz)`,
              "<",
              staleBefore,
            ),
            eb("b.attempted_at", "<", retryBefore),
          ]),
        ]),
      )
      .orderBy(sql`b.attempted_at asc nulls first`)
      .limit(limit)
      .execute();
    return rows;
  }

  async get(
    repositoryId: string,
    organizationId: string,
  ): Promise<RepositoryBriefRecord | null> {
    const row = await this.db
      .selectFrom("repository_briefs")
      .selectAll()
      .where("repository_id", "=", repositoryId)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      repositoryId: row.repository_id,
      organizationId: row.organization_id,
      headSha: row.head_sha,
      brief: row.brief,
      builtAt: row.built_at,
      attemptedAt: row.attempted_at,
      error: row.error,
    };
  }

  async saveBuilt(
    organizationId: string,
    repositoryId: string,
    headSha: string | null,
    brief: RepositoryBrief,
    at: Date,
  ): Promise<void> {
    const values = {
      head_sha: headSha,
      brief: JSON.stringify(brief),
      built_at: at,
      attempted_at: at,
      error: null,
    };
    await this.db
      .insertInto("repository_briefs")
      .values({
        repository_id: repositoryId,
        organization_id: organizationId,
        ...values,
      })
      .onConflict((oc) => oc.column("repository_id").doUpdateSet(values))
      .execute();
  }

  /** The branch has not moved: the stored brief is current as of `at`. */
  async markCurrent(
    organizationId: string,
    repositoryId: string,
    at: Date,
  ): Promise<void> {
    await this.db
      .updateTable("repository_briefs")
      .set({ built_at: at, attempted_at: at, error: null })
      .where("repository_id", "=", repositoryId)
      .where("organization_id", "=", organizationId)
      .where("brief", "is not", null)
      .execute();
  }

  async recordFailure(
    organizationId: string,
    repositoryId: string,
    error: string,
    at: Date,
  ): Promise<void> {
    const failure = { attempted_at: at, error: error.slice(0, 1000) };
    await this.db
      .insertInto("repository_briefs")
      .values({
        repository_id: repositoryId,
        organization_id: organizationId,
        ...failure,
      })
      .onConflict((oc) => oc.column("repository_id").doUpdateSet(failure))
      .execute();
  }
}
