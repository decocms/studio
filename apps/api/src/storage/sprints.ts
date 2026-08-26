import type { Kysely } from "kysely";
import type { Sprint, SprintState } from "@decocms/shared/sprints";
import { compareSprints } from "@decocms/shared/sprints";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";
import type { Database } from "./types";

/**
 * Sprints a board's cards belong to (migration 182).
 *
 * Every row here is currently a mirror of a Jira sprint, keyed by
 * `(organization_id, jira_sprint_id)` — the pull upserts on that pair, so a
 * renamed or re-dated sprint updates in place instead of forking. Rows are
 * never deleted by the sync: a closed sprint is the only record of what the
 * cards still pointing at it were planned into.
 */

type Row = {
  id: string;
  organization_id: string;
  name: string;
  state: SprintState;
  starts_at: Date | string | null;
  ends_at: Date | string | null;
  jira_sprint_id: string | null;
};

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toEntity(row: Row): Sprint {
  return {
    id: row.id,
    name: row.name,
    state: row.state,
    startsAt: toIso(row.starts_at),
    endsAt: toIso(row.ends_at),
  };
}

export interface JiraSprintUpsert {
  jiraSprintId: string;
  name: string;
  state: SprintState;
  startsAt: Date | null;
  endsAt: Date | null;
}

export class SprintStorage {
  constructor(private readonly db: Kysely<Database>) {}

  /** Every sprint of one org, in reading order (running → upcoming → history). */
  async listByOrg(organizationId: string): Promise<Sprint[]> {
    const rows = await this.db
      .selectFrom("task_board_sprints")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .execute();
    return (rows as Row[]).map(toEntity).sort(compareSprints);
  }

  /**
   * Mirror one Jira sprint, returning its local id.
   *
   * `name`/`state`/dates are Jira-owned, so the conflict branch overwrites all
   * of them: a sprint renamed or closed in Jira has to read that way here on
   * the next tick.
   */
  async upsertFromJira(
    organizationId: string,
    sprint: JiraSprintUpsert,
  ): Promise<string> {
    const row = await this.db
      .insertInto("task_board_sprints")
      .values({
        id: generatePrefixedId("sprint"),
        organization_id: organizationId,
        name: sprint.name,
        state: sprint.state,
        starts_at: sprint.startsAt,
        ends_at: sprint.endsAt,
        jira_sprint_id: sprint.jiraSprintId,
      })
      .onConflict((oc) =>
        oc.columns(["organization_id", "jira_sprint_id"]).doUpdateSet({
          name: sprint.name,
          state: sprint.state,
          starts_at: sprint.startsAt,
          ends_at: sprint.endsAt,
          updated_at: new Date(),
        }),
      )
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  }
}
