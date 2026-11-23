import { sql, type Kysely } from "kysely";
import { MAX_OPEN_PLAN_GOALS, type PlanGoal } from "@decocms/shared/plan-goals";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";
import type { Database } from "./types";

/**
 * Plan goals (migration 268). Every method takes the org in its WHERE clause.
 *
 * A goal is open until it is archived; only open goals show in the
 * picker, can be picked, or can have cases started toward them. Who uses a
 * goal is derived, never stored: the members whose Plan opens on it and the
 * members who started a case toward it.
 */

interface GoalRow {
  id: string;
  statement: string;
  source_label: string | null;
  source_quote: string | null;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

/** A goal row as stored, for checks before a write. */
export interface StoredPlanGoal extends GoalRow {
  open: boolean;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

/** The id the seed from the single store goal always takes, so two first
 *  reads at once insert one goal. */
export function seededGoalId(organizationId: string): string {
  return `goal_seed_${organizationId}`;
}

export class PlanGoalStorage {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * The org's open goals, oldest first, with who uses each. `canEditAll` is
   * the caller's admin standing; without it they may edit only their own.
   */
  async list(
    organizationId: string,
    userId: string,
    canEditAll: boolean,
  ): Promise<PlanGoal[]> {
    const { rows } = await sql<
      GoalRow & {
        users: string | number;
        last_case_at: Date | null;
        mine: boolean;
      }
    >`
      WITH usage AS (
        SELECT active_goal_id AS goal_id, user_id
          FROM member_plan_state
         WHERE organization_id = ${organizationId}
           AND active_goal_id IS NOT NULL
        UNION
        SELECT goal_id, user_id
          FROM plan_goal_cases
         WHERE organization_id = ${organizationId}
      )
      SELECT g.id, g.statement, g.source_label, g.source_quote,
             g.created_by, g.updated_by, g.created_at, g.updated_at,
             (SELECT count(*) FROM usage u WHERE u.goal_id = g.id) AS users,
             (SELECT max(c.created_at) FROM plan_goal_cases c
               WHERE c.organization_id = g.organization_id
                 AND c.goal_id = g.id) AS last_case_at,
             (g.created_by = ${userId} OR EXISTS (
               SELECT 1 FROM usage u
                WHERE u.goal_id = g.id AND u.user_id = ${userId}
             )) AS mine
        FROM plan_goals g
       WHERE g.organization_id = ${organizationId}
         AND g.archived_at IS NULL
       ORDER BY g.created_at, g.id
    `.execute(this.db);

    return rows.map((row) => ({
      id: row.id,
      statement: row.statement,
      source:
        row.source_label && row.source_quote
          ? { label: row.source_label, quote: row.source_quote }
          : null,
      created_by: row.created_by,
      updated_by: row.updated_by,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      users: Number(row.users),
      last_case_at: row.last_case_at ? iso(row.last_case_at) : null,
      mine: row.mine,
      can_edit: canEditAll || row.created_by === userId,
    }));
  }

  /**
   * Turn the single store goal into the org's first goal, once: nothing
   * happens when the org already has any goal, open or not.
   */
  async seedFromObjective(
    organizationId: string,
    objective: { statement: string; updated_by: string; updated_at: string },
  ): Promise<void> {
    const statement = objective.statement.trim();
    if (!statement) return;
    await sql`
      INSERT INTO plan_goals
        (id, organization_id, statement, created_by, updated_by,
         created_at, updated_at)
      SELECT ${seededGoalId(organizationId)}, ${organizationId}, ${statement},
             ${objective.updated_by}, ${objective.updated_by},
             ${objective.updated_at}, ${objective.updated_at}
       WHERE NOT EXISTS (
         SELECT 1 FROM plan_goals WHERE organization_id = ${organizationId}
       )
      ON CONFLICT (id) DO NOTHING
    `.execute(this.db);
  }

  async get(
    organizationId: string,
    id: string,
  ): Promise<StoredPlanGoal | null> {
    const row = await this.db
      .selectFrom("plan_goals")
      .select([
        "id",
        "statement",
        "source_label",
        "source_quote",
        "created_by",
        "updated_by",
        "created_at",
        "updated_at",
        "archived_at",
      ])
      .where("organization_id", "=", organizationId)
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) return null;
    const { archived_at, ...goal } = row;
    return { ...goal, open: archived_at === null };
  }

  /**
   * Add a goal. Null when the org already has {@link MAX_OPEN_PLAN_GOALS}
   * open goals; the count and the insert are one statement.
   */
  async create(params: {
    organizationId: string;
    statement: string;
    source: { label: string; quote: string } | null;
    by: string;
  }): Promise<string | null> {
    const id = generatePrefixedId("goal");
    const { rows } = await sql<{ id: string }>`
      INSERT INTO plan_goals
        (id, organization_id, statement, source_label, source_quote,
         created_by, updated_by)
      SELECT ${id}, ${params.organizationId}, ${params.statement},
             ${params.source?.label ?? null}, ${params.source?.quote ?? null},
             ${params.by}, ${params.by}
       WHERE (SELECT count(*) FROM plan_goals
               WHERE organization_id = ${params.organizationId}
                 AND archived_at IS NULL) < ${MAX_OPEN_PLAN_GOALS}
      RETURNING id
    `.execute(this.db);
    return rows[0]?.id ?? null;
  }

  /** Reword an open goal. False when the org has no such open goal. */
  async updateStatement(
    organizationId: string,
    id: string,
    statement: string,
    by: string,
  ): Promise<boolean> {
    const result = await this.db
      .updateTable("plan_goals")
      .set({ statement, updated_by: by, updated_at: new Date().toISOString() })
      .where("organization_id", "=", organizationId)
      .where("id", "=", id)
      .where("archived_at", "is", null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * Archive an open goal and clear it as anyone's goal, in one transaction.
   * Cases toward it keep their link. False when there was no open goal.
   */
  async archive(
    organizationId: string,
    id: string,
    by: string,
  ): Promise<boolean> {
    return await this.db.transaction().execute(async (trx) => {
      const now = new Date().toISOString();
      const result = await trx
        .updateTable("plan_goals")
        .set({ archived_at: now, updated_by: by, updated_at: now })
        .where("organization_id", "=", organizationId)
        .where("id", "=", id)
        .where("archived_at", "is", null)
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) return false;
      await trx
        .updateTable("member_plan_state")
        .set({ active_goal_id: null, updated_at: now })
        .where("organization_id", "=", organizationId)
        .where("active_goal_id", "=", id)
        .execute();
      return true;
    });
  }

  /**
   * The goal the member's Plan opens on: the one they picked while it is
   * open, otherwise the org's oldest open goal, or null when there is none.
   */
  async activeGoalId(
    organizationId: string,
    userId: string,
  ): Promise<string | null> {
    const picked = await this.db
      .selectFrom("member_plan_state as s")
      .innerJoin("plan_goals as g", "g.id", "s.active_goal_id")
      .select("g.id")
      .where("s.organization_id", "=", organizationId)
      .where("s.user_id", "=", userId)
      .where("g.organization_id", "=", organizationId)
      .where("g.archived_at", "is", null)
      .executeTakeFirst();
    if (picked) return picked.id;
    const oldest = await this.db
      .selectFrom("plan_goals")
      .select("id")
      .where("organization_id", "=", organizationId)
      .where("archived_at", "is", null)
      .orderBy("created_at")
      .orderBy("id")
      .limit(1)
      .executeTakeFirst();
    return oldest?.id ?? null;
  }

  /** Make an open goal the member's. False when the org has no such goal. */
  async setActive(
    organizationId: string,
    userId: string,
    goalId: string,
  ): Promise<boolean> {
    const { rows } = await sql<{ user_id: string }>`
      INSERT INTO member_plan_state (user_id, organization_id, active_goal_id)
      SELECT ${userId}, ${organizationId}, g.id
        FROM plan_goals g
       WHERE g.organization_id = ${organizationId}
         AND g.id = ${goalId}
         AND g.archived_at IS NULL
      ON CONFLICT (user_id, organization_id)
      DO UPDATE SET active_goal_id = EXCLUDED.active_goal_id,
                    updated_at = now()
      RETURNING user_id
    `.execute(this.db);
    return rows.length > 0;
  }

  /**
   * Tie a case chat to the open goal it was started toward. The first link
   * stands: recording the same chat again changes nothing. False when the
   * org has no such open goal.
   */
  async recordCase(params: {
    organizationId: string;
    threadId: string;
    goalId: string;
    userId: string;
  }): Promise<boolean> {
    const goal = await this.get(params.organizationId, params.goalId);
    if (!goal?.open) return false;
    await this.db
      .insertInto("plan_goal_cases")
      .values({
        organization_id: params.organizationId,
        thread_id: params.threadId,
        goal_id: params.goalId,
        user_id: params.userId,
      })
      .onConflict((oc) =>
        oc.columns(["organization_id", "thread_id"]).doNothing(),
      )
      .execute();
    return true;
  }

  /** The case chats started toward a goal, newest first. */
  async caseThreadIds(
    organizationId: string,
    goalId: string,
    limit: number,
  ): Promise<string[]> {
    const rows = await this.db
      .selectFrom("plan_goal_cases")
      .select("thread_id")
      .where("organization_id", "=", organizationId)
      .where("goal_id", "=", goalId)
      .orderBy("created_at", "desc")
      .orderBy("thread_id")
      .limit(limit)
      .execute();
    return rows.map((row) => row.thread_id);
  }
}
