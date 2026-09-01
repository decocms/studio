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
  tracker_statuses: string[];
};

const toEntity = (row: Row): BoardColumn => ({
  key: row.key,
  title: row.title,
  position: row.position,
  role: row.role,
  trackerStatuses: row.tracker_statuses,
});

export class BoardColumnStorage {
  constructor(private readonly db: Kysely<Database>) {}

  /** One org's columns, left to right. Empty when the board is Studio's own. */
  async listByOrg(organizationId: string): Promise<BoardColumn[]> {
    const rows = await this.db
      .selectFrom("task_board_columns")
      .select(["key", "title", "position", "role", "tracker_statuses"])
      .where("organization_id", "=", organizationId)
      .orderBy("position", "asc")
      .execute();
    return (rows as Row[]).map(toEntity);
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
    columns: { key: string; title: string; trackerStatuses: string[] }[],
  ): Promise<BoardColumn[]> {
    return await this.db.transaction().execute(async (tx) => {
      const existing = await tx
        .selectFrom("task_board_columns")
        .select(["key", "title", "role", "tracker_statuses"])
        .where("organization_id", "=", organizationId)
        .execute();
      const roleOf = new Map(existing.map((r) => [r.key, r.role]));

      // A column the tracker dropped that still holds cards is kept, appended
      // after the mirrored set. Deleting it is refused by the foreign key, and
      // rightly: moving someone's cards somewhere we picked is a worse answer
      // than showing a column their tracker no longer has. It disappears on the
      // first sync after the last card leaves it.
      const mirrored = new Set(columns.map((column) => column.key));
      const orphaned = existing.filter((row) => !mirrored.has(row.key));
      const occupied = orphaned.length
        ? await tx
            .selectFrom("task_board_items")
            .select("status")
            .distinct()
            .where("organization_id", "=", organizationId)
            .where(
              "status",
              "in",
              orphaned.map((row) => row.key),
            )
            .execute()
        : [];
      const keep = new Set(occupied.map((row) => row.status));

      const drop = orphaned
        .filter((row) => !keep.has(row.key))
        .map((row) => row.key);
      if (drop.length > 0) {
        await tx
          .deleteFrom("task_board_columns")
          .where("organization_id", "=", organizationId)
          .where("key", "in", drop)
          .execute();
      }

      const all = [
        ...columns,
        // A kept-but-dropped column keeps the statuses it last mirrored. They
        // are stale by definition, and that is the honest value: the tracker
        // no longer says anything about this column at all.
        ...orphaned
          .filter((row) => keep.has(row.key))
          .map((row) => ({
            key: row.key,
            title: row.title,
            trackerStatuses: row.tracker_statuses,
          })),
      ];
      if (all.length === 0) return [];

      const rows = all.map((column, position) => ({
        id: `tbc_${organizationId}_${column.key}`,
        organization_id: organizationId,
        key: column.key,
        title: column.title,
        position,
        role: roleOf.get(column.key) ?? null,
        // Stringified, not handed over as an array: `pg` serialises a JS array
        // as a Postgres ARRAY literal (`{a,b}`), which jsonb rejects outright
        // — and an EMPTY one as `{}`, which it accepts as an empty OBJECT. So
        // the silent case is the dangerous one.
        tracker_statuses: JSON.stringify(column.trackerStatuses),
      }));
      await tx
        .insertInto("task_board_columns")
        .values(rows)
        .onConflict((oc) =>
          oc.columns(["organization_id", "key"]).doUpdateSet((eb) => ({
            title: eb.ref("excluded.title"),
            position: eb.ref("excluded.position"),
            tracker_statuses: eb.ref("excluded.tracker_statuses"),
            updated_at: new Date(),
          })),
        )
        .execute();
      return all.map((column, position) => ({
        key: column.key,
        title: column.title,
        position,
        role: roleOf.get(column.key) ?? null,
        trackerStatuses: column.trackerStatuses,
      }));
    });
  }

  /**
   * Say what one of this board's columns means to Studio, or unsay it.
   *
   * A role means one column, not a set of them — `archiveColumn` and
   * `automationFor` both read it that way, picking whichever row happens to
   * match first. So giving a role to a column strips it from whichever column
   * held it before, in the same transaction, rather than leaving two columns
   * quietly claiming the same meaning.
   */
  async setRole(
    organizationId: string,
    key: string,
    role: string | null,
  ): Promise<boolean> {
    return await this.db.transaction().execute(async (tx) => {
      if (role !== null) {
        await tx
          .updateTable("task_board_columns")
          .set({ role: null, updated_at: new Date() })
          .where("organization_id", "=", organizationId)
          .where("role", "=", role)
          .where("key", "!=", key)
          .execute();
      }
      const result = await tx
        .updateTable("task_board_columns")
        .set({ role, updated_at: new Date() })
        .where("organization_id", "=", organizationId)
        .where("key", "=", key)
        .executeTakeFirst();
      return (result.numUpdatedRows ?? 0n) > 0n;
    });
  }
}
