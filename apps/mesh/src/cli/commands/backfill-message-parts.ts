/**
 * Backfill / reconcile `thread_messages.parts` → `message_parts`
 *
 * Part of the expand/contract migration started in migration 098. Dual-write
 * (in `ThreadStorage.saveMessages`) mirrors *new* messages into `message_parts`
 * live; this command handles the *existing* rows, in two modes.
 *
 *   # copy existing rows (run once after deploying dual-write)
 *   bun run deco backfill-message-parts [--dry-run] [--batch 200] [--limit N] \
 *     [--after-id <id>]
 *
 *   # verify the mirror matches and repair drift (run before cutting reads over)
 *   bun run deco backfill-message-parts --reconcile [--dry-run] [--batch 200] \
 *     [--limit N] [--after-id <id>]
 *
 * Scale (100k+ rows, many 50 MB+): we keyset-paginate over PRIMARY KEYS ONLY
 * (`--batch` ids per page — tiny, no blob transfer), fetch the grouped mirror
 * count for the page in one query, then process each message individually:
 * COPY skips any message that already has mirror rows (so resume / re-runs
 * never re-transfer a 50 MB blob), and only then fetches that one message's
 * `parts`. This bounds client memory to a single message instead of
 * batch × 50 MB.
 *
 * Each message's write is wrapped in its OWN transaction (delete+insert for
 * reconcile; chunked insert for copy) — never a run-wide transaction, which
 * would hold locks across all 100k rows and explode WAL. Inserts are chunked
 * under Postgres' 65535-parameter limit.
 *
 * `content` is stored as a JSON-text fragment (text column — parts can contain
 * ` `, which jsonb rejects). Idempotent: copy uses ON CONFLICT DO NOTHING and
 * skips already-mirrored messages; reconcile repairs only count mismatches. The
 * cursor is logged each page; pass `--after-id <id>` to resume.
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

type PartRow = {
  message_id: string;
  idx: number;
  type: string;
  content: string;
};

// 4 columns per row; stay well under Postgres' 65535 bind-parameter ceiling.
const MAX_ROWS_PER_INSERT = 10_000;

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h ? `${h}h` : "", m ? `${m}m` : "", `${sec}s`]
    .filter(Boolean)
    .join("");
}

/** Build the normalized rows for a message's parts blob (NUL-safe via JS). */
function partRowsFor(messageId: string, rawParts: unknown): PartRow[] {
  const parsed =
    typeof rawParts === "string"
      ? (JSON.parse(rawParts) as unknown[])
      : (rawParts as unknown[]);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((part, idx) => ({
    message_id: messageId,
    idx,
    type: String((part as { type?: unknown })?.type ?? "unknown"),
    content: JSON.stringify(part),
  }));
}

function* chunk<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}

export async function backfillMessagePartsCommand(
  opts: BackfillMessagePartsOptions,
): Promise<number> {
  const { dryRun, batch, reconcile } = opts;
  const database = getDb();
  const { db } = database;
  const mode = reconcile ? "reconcile" : "copy";
  const verb = dryRun
    ? reconcile
      ? "would-repair"
      : "would-copy"
    : reconcile
      ? "repaired"
      : "copied";

  // Exact count is cheap: count(*) reads tuple visibility, not the TOASTed blob.
  const totalRow = await db
    .selectFrom("thread_messages")
    .select((eb) => eb.fn.countAll().as("c"))
    .executeTakeFirst();
  const total = Number(totalRow?.c ?? 0);

  console.log(
    `[backfill-message-parts] starting (${mode})${dryRun ? " dry-run" : ""} ` +
      `total=${total} batch=${batch}${opts.limit ? ` limit=${opts.limit}` : ""}` +
      `${opts.afterId ? ` resume-after=${opts.afterId}` : ""}`,
  );

  const startedAt = Date.now();
  let scanned = 0;
  let changed = 0; // copied or repaired messages
  let skipped = 0; // already-mirrored (copy) / already-matching (reconcile)
  let partsWritten = 0;
  let bytesRead = 0;
  let errors = 0;
  let maxBytes = 0;
  let maxBytesId = "";
  let cursor = opts.afterId ?? "";

  const logProgress = (tag: string): void => {
    const elapsed = Date.now() - startedAt;
    const rate = elapsed > 0 ? scanned / (elapsed / 1000) : 0;
    const pct = total > 0 ? ((scanned / total) * 100).toFixed(1) : "?";
    const eta = rate > 0 ? ((total - scanned) / rate) * 1000 : 0;
    console.log(
      `[backfill-message-parts] ${tag} ${scanned}/${total} (${pct}%) ` +
        `${verb}=${changed} skipped=${skipped} parts=${partsWritten} ` +
        `read=${humanBytes(bytesRead)} errors=${errors} ` +
        `rate=${rate.toFixed(1)}/s elapsed=${fmtDuration(elapsed)} ` +
        `eta=${fmtDuration(eta)} cursor=${cursor}`,
    );
  };

  /** Copy: chunked insert, never clobbering live rows. Own transaction. */
  const copyMessage = async (rows: PartRow[]): Promise<void> => {
    await db.transaction().execute(async (trx) => {
      for (const part of chunk(rows, MAX_ROWS_PER_INSERT)) {
        await trx
          .insertInto("message_parts")
          .values(part)
          .onConflict((oc) => oc.columns(["message_id", "idx"]).doNothing())
          .execute();
      }
    });
  };

  /** Reconcile: atomically replace a message's mirror. Own transaction. */
  const replaceMessage = async (
    messageId: string,
    rows: PartRow[],
  ): Promise<void> => {
    await db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom("message_parts")
        .where("message_id", "=", messageId)
        .execute();
      for (const part of chunk(rows, MAX_ROWS_PER_INSERT)) {
        await trx.insertInto("message_parts").values(part).execute();
      }
    });
  };

  try {
    for (;;) {
      const remaining = opts.limit ? opts.limit - scanned : Infinity;
      if (remaining <= 0) break;

      // Page over PKs only — tiny, no blob transfer.
      const idRows = await db
        .selectFrom("thread_messages")
        .select("id")
        .where("id", ">", cursor)
        .orderBy("id", "asc")
        .limit(Math.min(batch, remaining))
        .execute();
      if (idRows.length === 0) break;
      const ids = idRows.map((r) => r.id);

      // One grouped query gives the current mirror state for the whole page.
      const mirror = new Map<string, number>();
      const counts = await db
        .selectFrom("message_parts")
        .select(["message_id", (eb) => eb.fn.countAll().as("cnt")])
        .where("message_id", "in", ids)
        .groupBy("message_id")
        .execute();
      for (const c of counts) mirror.set(c.message_id, Number(c.cnt));

      for (const id of ids) {
        cursor = id;
        scanned++;
        try {
          const have = mirror.get(id) ?? 0;

          // Copy: a message with any mirror rows is already done (single
          // atomic insert → 0 or all). Skip without touching its blob.
          if (!reconcile && have > 0) {
            skipped++;
            continue;
          }

          // Fetch just this one message's parts (bounds memory to one row).
          const row = await db
            .selectFrom("thread_messages")
            .select("parts")
            .where("id", "=", id)
            .executeTakeFirst();
          if (!row) {
            skipped++;
            continue;
          }

          const rawParts: unknown = row.parts;
          const partsText =
            typeof rawParts === "string" ? rawParts : JSON.stringify(rawParts);
          const b = Buffer.byteLength(partsText, "utf8");
          bytesRead += b;
          if (b > maxBytes) {
            maxBytes = b;
            maxBytesId = id;
            console.log(
              `[backfill-message-parts] new largest message ${id}: ${humanBytes(b)}`,
            );
          }

          const partRows = partRowsFor(id, rawParts);

          if (reconcile) {
            if (have === partRows.length) {
              skipped++;
              continue;
            }
            if (!dryRun) await replaceMessage(id, partRows);
          } else {
            if (partRows.length === 0) {
              skipped++;
              continue;
            }
            if (!dryRun) await copyMessage(partRows);
          }
          changed++;
          partsWritten += partRows.length;
        } catch (err) {
          errors++;
          console.error(
            `[backfill-message-parts] message ${id} failed, skipping:`,
            err,
          );
        }
      }

      logProgress("progress");
    }
  } finally {
    await closeDatabase(database).catch(() => {});
  }

  logProgress("done");
  console.log(
    `[backfill-message-parts] summary (${mode}) — scanned=${scanned} ` +
      `${verb}=${changed} skipped=${skipped} parts=${partsWritten} ` +
      `read=${humanBytes(bytesRead)} errors=${errors} ` +
      `largest=${maxBytesId ? `${maxBytesId} (${humanBytes(maxBytes)})` : "n/a"}`,
  );
  return errors > 0 ? 1 : 0;
}
