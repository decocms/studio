import { generatePrefixedId } from "@decocms/shared/utils/generate-id";
import type { Kysely, Selectable } from "kysely";
import type { AlertTable, Database } from "./types";

export interface Alert {
  id: string;
  source: string;
  subjectId: string;
  rule: string;
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
  ackedAt: string | null;
  ackedBy: string | null;
  ackNote: string | null;
  taskBoardItemId: string | null;
}

export interface NewAlert {
  organizationId: string;
  source: string;
  subjectId?: string;
  rule: string;
  title: string;
  body?: string;
  link?: string | null;
  createdAt?: Date;
}

const toAlert = (r: Selectable<AlertTable>): Alert => ({
  id: r.id,
  source: r.source,
  subjectId: r.subject_id,
  rule: r.rule,
  title: r.title,
  body: r.body,
  link: r.link,
  createdAt: r.created_at.toISOString(),
  ackedAt: r.acked_at?.toISOString() ?? null,
  ackedBy: r.acked_by,
  ackNote: r.ack_note,
  taskBoardItemId: r.task_board_item_id,
});

/** Alerts (migration 265). Every method takes the org in the WHERE clause. */
export class AlertStorage {
  constructor(private readonly db: Kysely<Database>) {}

  /** Opens the alert, or returns null when one for the same source, subject and rule is still open. */
  async open(input: NewAlert): Promise<Alert | null> {
    const row = await this.db
      .insertInto("alerts")
      .values({
        id: generatePrefixedId("alert"),
        organization_id: input.organizationId,
        source: input.source,
        subject_id: input.subjectId ?? "",
        rule: input.rule,
        title: input.title,
        body: input.body ?? "",
        link: input.link ?? null,
        ...(input.createdAt ? { created_at: input.createdAt } : {}),
      })
      .onConflict((oc) =>
        oc
          .columns(["organization_id", "source", "subject_id", "rule"])
          .where("acked_at", "is", null)
          .doNothing(),
      )
      .returningAll()
      .executeTakeFirst();
    return row ? toAlert(row) : null;
  }

  /** Newest first; open ones only unless `includeAcked`. */
  async list(
    organizationId: string,
    opts: { includeAcked?: boolean; limit?: number } = {},
  ): Promise<Alert[]> {
    let query = this.db
      .selectFrom("alerts")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(opts.limit ?? 50);
    if (!opts.includeAcked) query = query.where("acked_at", "is", null);
    return (await query.execute()).map(toAlert);
  }

  /**
   * Acks an open alert, optionally linking the task opened for it. Null when
   * the org has no such alert; an alert already acked comes back unchanged.
   */
  async ack(
    organizationId: string,
    id: string,
    by: string,
    opts: { note?: string; taskBoardItemId?: string } = {},
  ): Promise<Alert | null> {
    const row = await this.db
      .updateTable("alerts")
      .set({
        acked_at: new Date(),
        acked_by: by,
        ack_note: opts.note ?? null,
        ...(opts.taskBoardItemId
          ? { task_board_item_id: opts.taskBoardItemId }
          : {}),
      })
      .where("organization_id", "=", organizationId)
      .where("id", "=", id)
      .where("acked_at", "is", null)
      .returningAll()
      .executeTakeFirst();
    if (row) return toAlert(row);
    const existing = await this.db
      .selectFrom("alerts")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("id", "=", id)
      .executeTakeFirst();
    return existing ? toAlert(existing) : null;
  }
}
