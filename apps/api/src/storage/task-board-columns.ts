import type { Kysely } from "kysely";
import type { BoardColumn } from "@decocms/shared/task-board";
import type { Database } from "./types";

/**
 * The columns of a board whose columns belong to the org rather than to Studio
 * (migration 191). Empty for an org on the canonical board — those columns are
 * a constant, not rows.
 */
type Row = {
  key: string;
  title: string;
  position: number;
  role: string | null;
};

export class BoardColumnStorage {
  constructor(private readonly db: Kysely<Database>) {}

  /** One org's columns, left to right. Empty when the board is Studio's own. */
  async listByOrg(organizationId: string): Promise<BoardColumn[]> {
    const rows = await this.db
      .selectFrom("task_board_columns")
      .select(["key", "title", "position", "role"])
      .where("organization_id", "=", organizationId)
      .orderBy("position", "asc")
      .execute();
    return rows as Row[];
  }

  /**
   * Make this set of columns the board's, left to right in the order given.
   *
   * Written whole rather than merged: the caller is mirroring a board it does
   * not own, so a column that has disappeared upstream has to disappear here.
   * A column that survives keeps its `role`, which is ours and not the
   * tracker's to reassign.
   */
  async replaceAll(
    organizationId: string,
    columns: { key: string; title: string }[],
  ): Promise<BoardColumn[]> {
    return await this.db.transaction().execute(async (tx) => {
      const existing = await tx
        .selectFrom("task_board_columns")
        .select(["key", "role"])
        .where("organization_id", "=", organizationId)
        .execute();
      const roleOf = new Map(existing.map((r) => [r.key, r.role]));

      await tx
        .deleteFrom("task_board_columns")
        .where("organization_id", "=", organizationId)
        .execute();

      if (columns.length === 0) return [];

      const rows = columns.map((column, position) => ({
        id: `tbc_${organizationId}_${column.key}`,
        organization_id: organizationId,
        key: column.key,
        title: column.title,
        position,
        role: roleOf.get(column.key) ?? null,
      }));
      await tx.insertInto("task_board_columns").values(rows).execute();
      return rows.map(({ key, title, position, role }) => ({
        key,
        title,
        position,
        role,
      }));
    });
  }

  /** Say what one of this board's columns means to Studio, or unsay it. */
  async setRole(
    organizationId: string,
    key: string,
    role: string | null,
  ): Promise<boolean> {
    const result = await this.db
      .updateTable("task_board_columns")
      .set({ role, updated_at: new Date() })
      .where("organization_id", "=", organizationId)
      .where("key", "=", key)
      .executeTakeFirst();
    return (result.numUpdatedRows ?? 0n) > 0n;
  }
}
