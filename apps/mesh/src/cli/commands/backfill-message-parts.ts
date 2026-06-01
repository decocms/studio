/**
 * Backfill / reconcile `thread_messages.parts` → `message_parts`
 *
 * Part of the expand/contract migration started in migration 098. Dual-write
 * (in `ThreadStorage.saveMessages`) mirrors *new* messages into `message_parts`
 * live; this command handles the *existing* rows, in two modes.
 *
 *   # copy existing rows (run once after deploying dual-write)
 *   bun run deco backfill-message-parts [--dry-run] [--batch 50] [--limit N] \
 *     [--after-id <id>]
 *
 *   # verify the mirror matches and repair drift (run right before cutting
 *   # reads over to message_parts)
 *   bun run deco backfill-message-parts --reconcile [--dry-run] [--batch 200] \
 *     [--limit N] [--after-id <id>]
 *
 * Why reconcile exists: the copy pass uses ON CONFLICT DO NOTHING, so it never
 * clobbers live dual-write data — but a live edit that *shrinks* a message
 * during the copy window can race and leave a stale trailing part. Nothing
 * reads `message_parts` until the read-cutover PR, so this pass is the gate:
 * it re-derives the correct parts from `thread_messages.parts` (still the
 * source of truth until we stop writing it) and repairs any message whose
 * mirror count differs, by atomically replacing that message's parts.
 *
 * Scale: `thread_messages` is multi-GB with individual rows reaching 50 MB+.
 * Both modes keyset-paginate on the primary key (bounded PK range scan per
 * page, never a full scan) and operate one message per write statement so each
 * INSERT stays bounded. Idempotent: re-running copy is a no-op on copied rows;
 * re-running reconcile finds matching counts and repairs nothing. The cursor is
 * logged each page; pass `--after-id <id>` to resume an interrupted run.
 */

import { closeDatabase, getDb } from "../../database";

export interface BackfillMessagePartsOptions {
  dryRun: boolean;
  batch: number;
  limit?: number;
  afterId?: string;
  /** Verify the mirror matches `parts` and repair drift, instead of copying. */
  reconcile: boolean;
}

/** Build the normalized rows for a message's parts blob. */
function partRowsFor(
  messageId: string,
  rawParts: unknown,
): Array<{ message_id: string; idx: number; type: string; content: string }> {
  const parts =
    typeof rawParts === "string"
      ? (JSON.parse(rawParts) as unknown[])
      : (rawParts as unknown[]);
  if (!Array.isArray(parts)) return [];
  return parts.map((part, idx) => ({
    message_id: messageId,
    idx,
    type: String((part as { type?: unknown })?.type ?? "unknown"),
    content: JSON.stringify(part),
  }));
}

export async function backfillMessagePartsCommand(
  opts: BackfillMessagePartsOptions,
): Promise<number> {
  const { dryRun, batch, reconcile } = opts;
  const database = getDb();
  const { db } = database;
  const mode = reconcile ? "reconcile" : "copy";

  console.log(
    `[backfill-message-parts] starting (${mode})${dryRun ? " dry-run" : ""} ` +
      `batch=${batch}${opts.limit ? ` limit=${opts.limit}` : ""}`,
  );

  let scanned = 0;
  let changed = 0; // copied messages, or repaired messages
  let parts = 0; // parts written
  let errors = 0;
  let cursor = opts.afterId ?? "";
  if (cursor) {
    console.log(`[backfill-message-parts] resuming after id ${cursor}`);
  }
  const verb = dryRun
    ? reconcile
      ? "would-repair"
      : "would-copy"
    : reconcile
      ? "repaired"
      : "copied";

  /** Atomically replace one message's mirror with `rows` (used by reconcile). */
  const replaceMessage = async (
    messageId: string,
    rows: ReturnType<typeof partRowsFor>,
  ): Promise<void> => {
    await db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom("message_parts")
        .where("message_id", "=", messageId)
        .execute();
      if (rows.length > 0) {
        await trx.insertInto("message_parts").values(rows).execute();
      }
    });
  };

  try {
    for (;;) {
      const remaining = opts.limit ? opts.limit - scanned : Infinity;
      if (remaining <= 0) break;
      const rows = await db
        .selectFrom("thread_messages")
        .select(["id", "parts"])
        .where("id", ">", cursor)
        .orderBy("id", "asc")
        .limit(Math.min(batch, remaining))
        .execute();
      if (rows.length === 0) break;

      // Reconcile needs the current mirror counts for the page in one query.
      const mirrorCounts = new Map<string, number>();
      if (reconcile) {
        const counts = await db
          .selectFrom("message_parts")
          .select(["message_id", (eb) => eb.fn.countAll().as("cnt")])
          .where(
            "message_id",
            "in",
            rows.map((r) => r.id),
          )
          .groupBy("message_id")
          .execute();
        for (const c of counts) {
          mirrorCounts.set(c.message_id, Number(c.cnt));
        }
      }

      for (const row of rows) {
        cursor = row.id;
        scanned++;
        try {
          const partRows = partRowsFor(row.id, row.parts);

          if (reconcile) {
            // Repair only when the mirror's part count diverges from the blob.
            const have = mirrorCounts.get(row.id) ?? 0;
            if (have === partRows.length) continue;
            if (!dryRun) await replaceMessage(row.id, partRows);
            changed++;
            parts += partRows.length;
            continue;
          }

          // Copy mode: never clobber live dual-write rows.
          if (partRows.length === 0) continue;
          if (!dryRun) {
            await db
              .insertInto("message_parts")
              .values(partRows)
              .onConflict((oc) => oc.columns(["message_id", "idx"]).doNothing())
              .execute();
          }
          changed++;
          parts += partRows.length;
        } catch (err) {
          errors++;
          console.error(
            `[backfill-message-parts] message ${row.id} failed, skipping:`,
            err,
          );
        }
      }

      console.log(
        `[backfill-message-parts] scanned=${scanned} ${verb}=${changed} ` +
          `parts=${parts} errors=${errors} cursor=${cursor}`,
      );
    }
  } finally {
    await closeDatabase(database).catch(() => {});
  }

  console.log(
    `[backfill-message-parts] done (${mode}) — scanned=${scanned} ` +
      `${verb}=${changed} parts=${parts} errors=${errors}`,
  );
  return errors > 0 ? 1 : 0;
}
