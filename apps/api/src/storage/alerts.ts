import { generatePrefixedId } from "@decocms/shared/utils/generate-id";
import { type Kysely, sql } from "kysely";
import type { Database } from "./types";

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
  /** The acking user's name, when the user still exists. */
  ackedByName: string | null;
  ackNote: string | null;
  taskBoardItemId: string | null;
  /** The linked task's per-org sequence, behind its key (`DECO-12`). */
  taskKeySeq: number | null;
}

export interface AlertRuleSetting {
  source: string;
  rule: string;
  threshold: number;
  minVolume: number;
  updatedAt: string;
  updatedBy: string | null;
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

/** Alerts (migration 265). Every method takes the org in the WHERE clause. */
export class AlertStorage {
  constructor(private readonly db: Kysely<Database>) {}

  /** Alerts with who acked them and the linked task's key. */
  private select(organizationId: string) {
    return this.db
      .selectFrom("alerts as a")
      .leftJoin("user as u", "u.id", "a.acked_by")
      .leftJoin("task_board_items as t", (join) =>
        join
          .onRef("t.id", "=", "a.task_board_item_id")
          .onRef("t.organization_id", "=", "a.organization_id"),
      )
      .selectAll("a")
      .select(["u.name as acked_by_name", "t.key_seq as task_key_seq"])
      .where("a.organization_id", "=", organizationId);
  }

  private async byId(organizationId: string, id: string) {
    const row = await this.select(organizationId)
      .where("a.id", "=", id)
      .executeTakeFirst();
    return row ? toAlert(row) : null;
  }

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
      .returning("id")
      .executeTakeFirst();
    return row ? this.byId(input.organizationId, row.id) : null;
  }

  /**
   * Opens the alert unless one for the same source, subject and rule is still
   * open or was created at or after `input.createdAt`: a crossing judged again
   * (a re-run tick, the next tick in the same hour) opens it once, even if it
   * was acked in between.
   */
  async openOnce(input: NewAlert & { createdAt: Date }): Promise<Alert | null> {
    return this.db.transaction().execute(async (trx) => {
      const key = `alert:${input.organizationId}:${input.source}:${input.subjectId ?? ""}:${input.rule}`;
      await sql`select pg_advisory_xact_lock(hashtext(${key})::bigint)`.execute(
        trx,
      );
      const seen = await trx
        .selectFrom("alerts")
        .select("id")
        .where("organization_id", "=", input.organizationId)
        .where("source", "=", input.source)
        .where("subject_id", "=", input.subjectId ?? "")
        .where("rule", "=", input.rule)
        .where("created_at", ">=", input.createdAt)
        .executeTakeFirst();
      return seen ? null : new AlertStorage(trx).open(input);
    });
  }

  /**
   * Newest first, `limit` at a time; `cursor` is the previous page's
   * `nextCursor`, null on the last page.
   */
  async list(
    organizationId: string,
    opts: {
      status?: "open" | "acked" | "all";
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<{ alerts: Alert[]; nextCursor: string | null }> {
    const limit = opts.limit ?? 50;
    let query = this.select(organizationId)
      .orderBy("a.created_at", "desc")
      .orderBy("a.id", "desc")
      .limit(limit + 1);
    const status = opts.status ?? "open";
    if (status === "open") query = query.where("a.acked_at", "is", null);
    if (status === "acked") query = query.where("a.acked_at", "is not", null);
    const after = opts.cursor ? parseCursor(opts.cursor) : null;
    if (after) {
      query = query.where((eb) =>
        eb.or([
          eb("a.created_at", "<", after.createdAt),
          eb.and([
            eb("a.created_at", "=", after.createdAt),
            eb("a.id", "<", after.id),
          ]),
        ]),
      );
    }
    const rows = (await query.execute()).map(toAlert);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      alerts: page,
      nextCursor:
        rows.length > limit && last ? `${last.createdAt}|${last.id}` : null,
    };
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
    await this.db
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
      .execute();
    return this.byId(organizationId, id);
  }

  /** The org's own thresholds for `source`'s rules; rules it never set are absent. */
  async listRuleSettings(
    organizationId: string,
    source: string,
  ): Promise<AlertRuleSetting[]> {
    const rows = await this.db
      .selectFrom("alert_rule_settings")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("source", "=", source)
      .execute();
    return rows.map((r) => ({
      source: r.source,
      rule: r.rule,
      threshold: r.threshold,
      minVolume: r.min_volume,
      updatedAt: r.updated_at.toISOString(),
      updatedBy: r.updated_by,
    }));
  }

  async setRuleSetting(
    organizationId: string,
    setting: {
      source: string;
      rule: string;
      threshold: number;
      minVolume: number;
    },
    by: string,
  ): Promise<void> {
    const now = new Date();
    await this.db
      .insertInto("alert_rule_settings")
      .values({
        organization_id: organizationId,
        source: setting.source,
        rule: setting.rule,
        threshold: setting.threshold,
        min_volume: setting.minVolume,
        updated_at: now,
        updated_by: by,
      })
      .onConflict((oc) =>
        oc.columns(["organization_id", "source", "rule"]).doUpdateSet({
          threshold: setting.threshold,
          min_volume: setting.minVolume,
          updated_at: now,
          updated_by: by,
        }),
      )
      .execute();
  }
}

/** `<created_at ISO>|<id>`; anything else reads as the first page. */
function parseCursor(cursor: string) {
  const at = cursor.indexOf("|");
  const createdAt = new Date(cursor.slice(0, at));
  const id = cursor.slice(at + 1);
  return at > 0 && id && !Number.isNaN(createdAt.getTime())
    ? { createdAt, id }
    : null;
}

type AlertRow = Awaited<
  ReturnType<ReturnType<AlertStorage["select"]>["executeTakeFirstOrThrow"]>
>;

function toAlert(r: AlertRow): Alert {
  return {
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
    ackedByName: r.acked_by_name ?? null,
    ackNote: r.ack_note,
    taskBoardItemId: r.task_board_item_id,
    taskKeySeq: r.task_key_seq ?? null,
  };
}
