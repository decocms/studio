import type { Kysely } from "kysely";
import type { Database } from "./types";

/**
 * A rule the board runs when a card lands in one of its columns (migration
 * 189).
 *
 * `prompt` null means the Super Agent's own instruction, which is what every
 * run used before rules existed and what a rule carried over from
 * `auto_delegate` still means.
 */
export interface ColumnAutomation {
  columnKey: string;
  prompt: string | null;
}

type Row = { column_key: string; prompt: string | null };

export class ColumnAutomationStorage {
  constructor(private readonly db: Kysely<Database>) {}

  /** Every rule on this org's board, by column. */
  async listByOrg(organizationId: string): Promise<ColumnAutomation[]> {
    const rows = await this.db
      .selectFrom("task_board_column_automations")
      .select(["column_key", "prompt"])
      .where("organization_id", "=", organizationId)
      .orderBy("column_key", "asc")
      .execute();
    return (rows as Row[]).map((r) => ({
      columnKey: r.column_key,
      prompt: r.prompt,
    }));
  }

  /** The rule on one column, or null when nothing happens there. */
  async get(
    organizationId: string,
    columnKey: string,
  ): Promise<ColumnAutomation | null> {
    const row = await this.db
      .selectFrom("task_board_column_automations")
      .select(["column_key", "prompt"])
      .where("organization_id", "=", organizationId)
      .where("column_key", "=", columnKey)
      .executeTakeFirst();
    if (!row) return null;
    const typed = row as Row;
    return { columnKey: typed.column_key, prompt: typed.prompt };
  }

  /** Create the rule on a column, or replace the instruction already there. */
  async upsert(
    organizationId: string,
    columnKey: string,
    prompt: string | null,
  ): Promise<ColumnAutomation> {
    await this.db
      .insertInto("task_board_column_automations")
      .values({
        id: `tbca_${organizationId}_${columnKey}`,
        organization_id: organizationId,
        column_key: columnKey,
        prompt,
      })
      .onConflict((oc) =>
        oc
          .columns(["organization_id", "column_key"])
          .doUpdateSet({ prompt, updated_at: new Date() }),
      )
      .execute();
    return { columnKey, prompt };
  }

  /** Turn the automation off. Deleting IS the off switch, so "configured" and
   *  "enabled" cannot drift apart. Returns whether there was one. */
  async remove(organizationId: string, columnKey: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("task_board_column_automations")
      .where("organization_id", "=", organizationId)
      .where("column_key", "=", columnKey)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }
}
