import { sql, type Kysely } from "kysely";
import {
  compareSprints,
  FINISHED_STATUSES,
  type Sprint,
  type SprintState,
} from "@decocms/shared/sprints";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";
import type { Database } from "./types";

/**
 * Sprints the board owns (migration 236), and the card moves their lifecycle
 * implies.
 *
 * State only moves forward, `future → active → closed`, and each step is a
 * compare-and-set on the current state, so two people starting or completing
 * the same sprint at once get one transition and one refusal.
 */

/** Days come back as text: `pg` turns a `date` into a `Date` at local
 *  midnight, which shifts the day in any timezone west of UTC. */
const SPRINT_COLUMNS = [
  "id",
  "name",
  "state",
  sql<string | null>`to_char(start_date, 'YYYY-MM-DD')`.as("start_date"),
  sql<string | null>`to_char(end_date, 'YYYY-MM-DD')`.as("end_date"),
] as const;

type Row = {
  id: string;
  name: string;
  state: SprintState;
  start_date: string | null;
  end_date: string | null;
};

function toSprint(row: Row): Sprint {
  return {
    id: row.id,
    name: row.name,
    state: row.state,
    startDate: row.start_date,
    endDate: row.end_date,
  };
}

/** What completing a sprint did: the sprint as closed, and the cards it
 *  moved to `movedTo` (a sprint id, or null for the backlog). */
export interface SprintCompletion {
  sprint: Sprint;
  movedTo: string | null;
  movedItemIds: string[];
}

export class SprintStorage {
  constructor(private readonly db: Kysely<Database>) {}

  /** Every sprint of one org, in reading order (running → next → history). */
  async listByOrg(organizationId: string): Promise<Sprint[]> {
    const rows = await this.db
      .selectFrom("task_board_sprints")
      .select(SPRINT_COLUMNS)
      .where("organization_id", "=", organizationId)
      .execute();
    return rows.map(toSprint).sort(compareSprints);
  }

  async get(organizationId: string, id: string): Promise<Sprint | null> {
    const row = await this.db
      .selectFrom("task_board_sprints")
      .select(SPRINT_COLUMNS)
      .where("organization_id", "=", organizationId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? toSprint(row) : null;
  }

  async create(params: {
    organizationId: string;
    name: string;
    startDate: string | null;
    endDate: string | null;
    by: string;
  }): Promise<Sprint> {
    const row = await this.db
      .insertInto("task_board_sprints")
      .values({
        id: generatePrefixedId("sprint"),
        organization_id: params.organizationId,
        name: params.name,
        start_date: params.startDate,
        end_date: params.endDate,
        created_by: params.by,
      })
      .returning(SPRINT_COLUMNS)
      .executeTakeFirstOrThrow();
    return toSprint(row);
  }

  /** Rename or re-date a sprint. Null when the org has no such sprint. */
  async update(
    organizationId: string,
    id: string,
    data: {
      name?: string;
      startDate?: string | null;
      endDate?: string | null;
    },
  ): Promise<Sprint | null> {
    const row = await this.db
      .updateTable("task_board_sprints")
      .set({
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.startDate !== undefined ? { start_date: data.startDate } : {}),
        ...(data.endDate !== undefined ? { end_date: data.endDate } : {}),
        updated_at: new Date().toISOString(),
      })
      .where("organization_id", "=", organizationId)
      .where("id", "=", id)
      .returning(SPRINT_COLUMNS)
      .executeTakeFirst();
    return row ? toSprint(row) : null;
  }

  /** `future → active`. Null when the sprint is not this org's or is not
   *  planned (already running, or closed). */
  async start(organizationId: string, id: string): Promise<Sprint | null> {
    const row = await this.db
      .updateTable("task_board_sprints")
      .set({ state: "active", updated_at: new Date().toISOString() })
      .where("organization_id", "=", organizationId)
      .where("id", "=", id)
      .where("state", "=", "future")
      .returning(SPRINT_COLUMNS)
      .executeTakeFirst();
    return row ? toSprint(row) : null;
  }

  /**
   * `active → closed`, carrying every unfinished card to `moveTo` (another of
   * this org's sprints that is not closed, or null for the backlog) in the
   * same transaction. Finished cards stay as the sprint's record.
   *
   * The destination is read `FOR SHARE`, so completing it at the same time
   * waits for this transaction instead of closing under the cards it receives.
   *
   * Null when the sprint is not this org's or is not running. Throws when
   * `moveTo` is not a sprint the cards can go to; nothing is written then.
   */
  async complete(params: {
    organizationId: string;
    id: string;
    moveTo: string | null;
    by: string;
  }): Promise<SprintCompletion | null> {
    const { organizationId, id, moveTo, by } = params;
    return this.db.transaction().execute(async (trx) => {
      const closed = await trx
        .updateTable("task_board_sprints")
        .set({ state: "closed", updated_at: new Date().toISOString() })
        .where("organization_id", "=", organizationId)
        .where("id", "=", id)
        .where("state", "=", "active")
        .returning(SPRINT_COLUMNS)
        .executeTakeFirst();
      if (!closed) return null;

      if (moveTo !== null) {
        const target = await trx
          .selectFrom("task_board_sprints")
          .select("state")
          .where("organization_id", "=", organizationId)
          .where("id", "=", moveTo)
          .forShare()
          .executeTakeFirst();
        if (!target || target.state === "closed") {
          throw new Error(
            "moveTo is not an open sprint on this board — pass a planned or " +
              "running sprint's id, or null for the backlog",
          );
        }
      }

      const moved = await trx
        .updateTable("task_board_items")
        .set({
          sprint_id: moveTo,
          updated_by: by,
          updated_at: new Date().toISOString(),
        })
        .where("organization_id", "=", organizationId)
        .where("sprint_id", "=", id)
        .where("status", "not in", [...FINISHED_STATUSES])
        .returning("id")
        .execute();

      return {
        sprint: toSprint(closed),
        movedTo: moveTo,
        movedItemIds: moved.map((row) => row.id),
      };
    });
  }

  /**
   * Delete a sprint. Its cards go to the backlog through the FK's `ON DELETE
   * SET NULL`; their ids are returned so the caller can log the move. Null
   * when the org has no such sprint.
   */
  async delete(
    organizationId: string,
    id: string,
  ): Promise<{ sprint: Sprint; movedItemIds: string[] } | null> {
    return this.db.transaction().execute(async (trx) => {
      const sprint = await trx
        .selectFrom("task_board_sprints")
        .select(SPRINT_COLUMNS)
        .where("organization_id", "=", organizationId)
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (!sprint) return null;
      const items = await trx
        .selectFrom("task_board_items")
        .select("id")
        .where("organization_id", "=", organizationId)
        .where("sprint_id", "=", id)
        .execute();
      await trx
        .deleteFrom("task_board_sprints")
        .where("organization_id", "=", organizationId)
        .where("id", "=", id)
        .execute();
      return {
        sprint: toSprint(sprint),
        movedItemIds: items.map((row) => row.id),
      };
    });
  }
}
