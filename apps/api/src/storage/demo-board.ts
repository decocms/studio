/**
 * A demo org's task board, frozen and thawed.
 *
 * A capture copies the rows that draw the board — its cards and every run,
 * message, comment and timeline entry under them — as Postgres renders them
 * (`to_jsonb`), and a restore writes them back through
 * `jsonb_populate_recordset`. The copy follows the schema without a column
 * list to maintain: a column added later takes its default, one dropped later
 * is skipped.
 *
 * Every instant moves forward by the time since the capture, so "moved to In
 * Review 2 hours ago" still reads that way the next morning.
 */

import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import { LANES } from "@decocms/shared/task-board";
import { TaskBoardItemPrSchema } from "../tools/task-board/schema";
import { TERMINAL_THREAD_STATUSES } from "./task-board";
import type { Database, TaskBoardItemPrRef } from "./types";

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** The rows a snapshot copies, in insert order (parents first): the column
 *  that finds them and the columns that hold an instant. */
const TABLES = {
  task_board_items: {
    by: "id",
    times: [
      "created_at",
      "updated_at",
      "due_date",
      "dismissed_at",
      "last_swept_at",
      "review_cycle_started_at",
      "retry_at",
    ],
  },
  threads: {
    by: "id",
    times: [
      "created_at",
      "updated_at",
      "run_started_at",
      "last_progress_at",
      "cancel_requested_at",
    ],
  },
  thread_message_parts: { by: "thread_id", times: ["created_at"] },
  thread_messages: { by: "thread_id", times: ["created_at", "updated_at"] },
  thread_repositories: { by: "thread_id", times: ["added_at"] },
  task_board_item_threads: { by: "task_board_item_id", times: ["created_at"] },
  task_board_item_prs: { by: "task_board_item_id", times: ["created_at"] },
  task_board_item_tags: { by: "task_board_item_id", times: ["created_at"] },
  task_board_comments: {
    by: "task_board_item_id",
    times: ["created_at", "updated_at"],
  },
  task_board_activity: { by: "task_board_item_id", times: ["occurred_at"] },
} as const satisfies Record<string, { by: string; times: readonly string[] }>;

type SnapshotTable = keyof typeof TABLES;
const SNAPSHOT_TABLES = Object.keys(TABLES) as SnapshotTable[];

/** Children of a card, cleared before its snapshot rows go back. */
const ITEM_CHILD_TABLES = [
  "task_board_item_threads",
  "task_board_item_prs",
  "task_board_item_tags",
  "task_board_comments",
  "task_board_activity",
  "task_board_review_claims",
] as const;

const RowSchema = z.record(z.string().regex(IDENTIFIER), z.unknown());
type Row = z.infer<typeof RowSchema>;

const rowsOf = z.array(RowSchema);

const DemoBoardSnapshotSchema = z.object({
  version: z.literal(1),
  capturedAt: z.string().datetime(),
  /** Cards an agent may really run; a restore clears their runs. */
  liveItemIds: z.array(z.string()),
  /** Cards kept archived: someone unarchiving one mid-demo is undone. */
  archivedItemIds: z.array(z.string()),
  rows: z.object({
    task_board_items: rowsOf,
    threads: rowsOf,
    thread_message_parts: rowsOf,
    thread_messages: rowsOf,
    thread_repositories: rowsOf,
    task_board_item_threads: rowsOf,
    task_board_item_prs: rowsOf,
    task_board_item_tags: rowsOf,
    task_board_comments: rowsOf,
    task_board_activity: rowsOf,
  }),
});

/** Each frozen card's pull requests as the provider described them at capture. */
const PrCardListSchema = z.array(TaskBoardItemPrSchema);
const PrCardsSchema = z.record(z.string(), PrCardListSchema);

export type DemoBoardSnapshot = z.infer<typeof DemoBoardSnapshotSchema>;
type PrCard = z.infer<typeof TaskBoardItemPrSchema>;

/**
 * Whether the card in `itemColumn` is one a demo org froze, with the reset
 * on. Sweeps filter on its negation: a frozen card is a picture of past work,
 * and nothing may advance, review, retry or archive it.
 */
export function isFrozenDemoCard(itemColumn: string) {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM demo_board_snapshots d
    JOIN organization_settings s ON s."organizationId" = d.organization_id
    WHERE d.frozen_item_ids ? ${sql.ref(itemColumn)}
      AND (s.flags->>'demo_board_reset')::boolean IS TRUE
  )`;
}

export interface DemoBoardStatus {
  capturedAt: string;
  capturedBy: string;
  frozenItems: number;
  liveItemIds: string[];
  lastResetAt: string | null;
  lastResetError: string | null;
  deadPreviewUrls: string[];
}

export interface DemoBoardRestore {
  previewUrls: string[];
  restoredItemIds: string[];
  deletedItemIds: string[];
  rearchivedItemIds: string[];
  /** Opened after the capture by a card the restore reset or removed. */
  prsToClose: TaskBoardItemPrRef[];
}

/** Moves every instant in `times` by `shiftMs`; anything unparseable stays. */
function shiftRow(row: Row, times: readonly string[], shiftMs: number): Row {
  const out = { ...row };
  for (const column of times) {
    const value = out[column];
    if (typeof value !== "string") continue;
    const at = Date.parse(value);
    if (Number.isNaN(at)) continue;
    out[column] = new Date(at + shiftMs).toISOString();
  }
  return out;
}

const prKey = (itemId: unknown, url: unknown) => `${itemId}\n${url}`;

function prRef(row: Row): TaskBoardItemPrRef | null {
  const parsed = z
    .object({
      url: z.string(),
      pr_number: z.number(),
      repo_owner: z.string(),
      repo_name: z.string(),
      connection_id: z.string().nullable(),
      repository_id: z.string().nullable(),
      created_at: z.unknown(),
    })
    .safeParse(row);
  if (!parsed.success) return null;
  const pr = parsed.data;
  return {
    url: pr.url,
    number: pr.pr_number,
    repoOwner: pr.repo_owner,
    repoName: pr.repo_name,
    connectionId: pr.connection_id,
    repositoryId: pr.repository_id,
    createdAt: String(pr.created_at),
  };
}

const stringIds = (rows: Row[], column: string) =>
  rows.flatMap((row) => {
    const value = row[column];
    return typeof value === "string" ? [value] : [];
  });

export class DemoBoardStorage {
  constructor(private db: Kysely<Database>) {}

  private async select(
    db: Kysely<Database>,
    table: SnapshotTable,
    ids: string[],
  ): Promise<Row[]> {
    if (ids.length === 0) return [];
    const { rows } = await sql<{ row: unknown }>`
      SELECT to_jsonb(t) AS row FROM ${sql.table(table)} t
      WHERE ${sql.ref(`t.${TABLES[table].by}`)} = ANY(${ids})
    `.execute(db);
    return rows.map(({ row }) => RowSchema.parse(row));
  }

  /**
   * The board as it stands: every card that isn't archived or dismissed is
   * frozen with its runs, `liveItemIds` keep only the card itself, and the
   * archived ones are remembered as archived.
   */
  async capture(
    organizationId: string,
    opts: {
      liveItemIds: string[];
      capturedBy: string;
      /** The provider's view of a card's pull requests; throws when unreadable. */
      readPrCards: (itemId: string) => Promise<PrCard[]>;
    },
  ): Promise<DemoBoardSnapshot> {
    const items = await this.db
      .selectFrom("task_board_items")
      .select(["id", "status"])
      .where("organization_id", "=", organizationId)
      .where("dismissed_at", "is", null)
      .execute();
    const archivedItemIds = items
      .filter((item) => item.status === LANES.archive)
      .map((item) => item.id);
    const onBoard = new Set(
      items.filter((item) => item.status !== LANES.archive).map((i) => i.id),
    );
    const notOnBoard = opts.liveItemIds.filter((id) => !onBoard.has(id));
    if (notOnBoard.length > 0) {
      throw new Error(
        `Live cards must be on the board (not archived): ${notOnBoard.join(", ")}`,
      );
    }
    const live = new Set(opts.liveItemIds);
    const frozenIds = [...onBoard].filter((id) => !live.has(id));
    const itemIds = [...onBoard];

    const links = await this.select(
      this.db,
      "task_board_item_threads",
      frozenIds,
    );
    const threadIds = [...new Set(stringIds(links, "thread_id"))];
    const threads = await this.select(this.db, "threads", threadIds);
    const running = threads.filter(
      (thread) => !TERMINAL_THREAD_STATUSES.has(String(thread.status)),
    );
    if (running.length > 0) {
      throw new Error(
        `Wait for these runs to finish before capturing: ${stringIds(running, "id").join(", ")}`,
      );
    }

    const liveRows = (
      await this.select(this.db, "task_board_items", [...live])
    ).map((row) => ({
      ...row,
      last_swept_at: null,
      review_cycle_started_at: null,
      retry_at: null,
      retry_attempts: 0,
    }));
    const frozenRows = await this.select(
      this.db,
      "task_board_items",
      frozenIds,
    );

    const prs = await this.select(this.db, "task_board_item_prs", frozenIds);
    const prCards: Record<string, PrCard[]> = {};
    // One card at a time: a burst of provider reads is what blanks them.
    for (const itemId of new Set(stringIds(prs, "task_board_item_id"))) {
      prCards[itemId] = await opts.readPrCards(itemId);
    }

    const snapshot: DemoBoardSnapshot = {
      version: 1,
      capturedAt: new Date().toISOString(),
      liveItemIds: opts.liveItemIds,
      archivedItemIds,
      rows: {
        task_board_items: [...frozenRows, ...liveRows],
        threads,
        thread_message_parts: await this.select(
          this.db,
          "thread_message_parts",
          threadIds,
        ),
        thread_messages: await this.select(
          this.db,
          "thread_messages",
          threadIds,
        ),
        thread_repositories: await this.select(
          this.db,
          "thread_repositories",
          threadIds,
        ),
        task_board_item_threads: links,
        task_board_item_prs: prs,
        task_board_item_tags: await this.select(
          this.db,
          "task_board_item_tags",
          itemIds,
        ),
        task_board_comments: await this.select(
          this.db,
          "task_board_comments",
          frozenIds,
        ),
        task_board_activity: await this.select(
          this.db,
          "task_board_activity",
          frozenIds,
        ),
      },
    };

    const columns = {
      snapshot: JSON.stringify(snapshot),
      frozen_item_ids: JSON.stringify(frozenIds),
      pr_cards: JSON.stringify(prCards),
      captured_at: snapshot.capturedAt,
      captured_by: opts.capturedBy,
    };
    await this.db
      .insertInto("demo_board_snapshots")
      .values({ organization_id: organizationId, ...columns })
      .onConflict((oc) =>
        oc.column("organization_id").doUpdateSet({
          ...columns,
          last_reset_at: null,
          last_reset_error: null,
          dead_preview_urls: null,
        }),
      )
      .execute();
    return snapshot;
  }

  async getStatus(organizationId: string): Promise<DemoBoardStatus | null> {
    const row = await this.db
      .selectFrom("demo_board_snapshots")
      .select([
        "captured_at",
        "captured_by",
        "frozen_item_ids",
        "last_reset_at",
        "last_reset_error",
        "dead_preview_urls",
        sql<unknown>`snapshot->'liveItemIds'`.as("live_item_ids"),
      ])
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    if (!row) return null;
    const ids = z.array(z.string());
    return {
      capturedAt: row.captured_at.toISOString(),
      capturedBy: row.captured_by,
      frozenItems: ids.parse(row.frozen_item_ids).length,
      liveItemIds: ids.parse(row.live_item_ids),
      lastResetAt: row.last_reset_at?.toISOString() ?? null,
      lastResetError: row.last_reset_error,
      deadPreviewUrls: z
        .array(z.string())
        .catch([])
        .parse(row.dead_preview_urls),
    };
  }

  /** Read from settings first so an org with the reset off never touches
   *  the snapshot table on the board's and dispatch's hot paths. */
  private async resetOn(organizationId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("organization_settings")
      .select(
        sql<boolean>`(flags->>'demo_board_reset')::boolean IS TRUE`.as("on"),
      )
      .where("organizationId", "=", organizationId)
      .executeTakeFirst();
    return row?.on === true;
  }

  /** The org's frozen cards; empty unless it captured one and the reset is on. */
  async frozenItemIds(organizationId: string): Promise<Set<string>> {
    if (!(await this.resetOn(organizationId))) return new Set();
    const row = await this.db
      .selectFrom("demo_board_snapshots")
      .select("frozen_item_ids")
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    return new Set(row ? z.array(z.string()).parse(row.frozen_item_ids) : []);
  }

  /** Whether `threadId` is a run on one of the org's frozen cards. */
  async isFrozenThread(
    organizationId: string,
    threadId: string,
  ): Promise<boolean> {
    const frozen = await this.frozenItemIds(organizationId);
    if (frozen.size === 0) return false;
    const row = await this.db
      .selectFrom("task_board_item_threads")
      .select("thread_id")
      .where("organization_id", "=", organizationId)
      .where("thread_id", "=", threadId)
      .where("task_board_item_id", "in", [...frozen])
      .executeTakeFirst();
    return !!row;
  }

  /** A frozen card's pull requests as captured; null for any other card. */
  async frozenPrCards(
    organizationId: string,
    itemId: string,
  ): Promise<PrCard[] | null> {
    if (!(await this.frozenItemIds(organizationId)).has(itemId)) return null;
    const row = await this.db
      .selectFrom("demo_board_snapshots")
      .select(sql<unknown>`pr_cards->${itemId}`.as("cards"))
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    return PrCardListSchema.parse(row?.cards ?? []);
  }

  /** Orgs that have captured a board, flag or not. */
  async listOrganizationIds(): Promise<string[]> {
    const rows = await this.db
      .selectFrom("demo_board_snapshots")
      .select("organization_id")
      .execute();
    return rows.map((row) => row.organization_id);
  }

  async recordReset(
    organizationId: string,
    outcome: { at: Date; error: string | null; deadPreviewUrls: string[] },
  ): Promise<void> {
    await this.db
      .updateTable("demo_board_snapshots")
      .set({
        last_reset_at: outcome.at,
        last_reset_error: outcome.error,
        dead_preview_urls: JSON.stringify(outcome.deadPreviewUrls),
      })
      .where("organization_id", "=", organizationId)
      .execute();
  }

  /**
   * Puts the board back, in one transaction: cards created since the capture
   * and chats started since are deleted, captured cards get their rows back
   * shifted to `now`, and archived ones are archived again. Null when the org
   * never captured one.
   */
  async restore(
    organizationId: string,
    now: Date,
  ): Promise<DemoBoardRestore | null> {
    return await this.db.transaction().execute(async (tx) => {
      // The lock serializes the daily run against a manual one.
      const stored = await tx
        .selectFrom("demo_board_snapshots")
        .select(["snapshot", "pr_cards"])
        .where("organization_id", "=", organizationId)
        .forUpdate()
        .executeTakeFirst();
      if (!stored) return null;
      const snapshot = DemoBoardSnapshotSchema.parse(stored.snapshot);
      const capturedAt = new Date(snapshot.capturedAt);
      const shiftMs = now.getTime() - capturedAt.getTime();

      const capturedIds = stringIds(snapshot.rows.task_board_items, "id");
      const kept = new Set([...capturedIds, ...snapshot.archivedItemIds]);
      const current = await tx
        .selectFrom("task_board_items")
        .select(["id", "created_at"])
        .where("organization_id", "=", organizationId)
        .execute();
      const deletedItemIds = current
        .filter((item) => !kept.has(item.id) && item.created_at > capturedAt)
        .map((item) => item.id);
      const touchedItemIds = [...capturedIds, ...deletedItemIds];

      const snapshotPrs = new Set(
        snapshot.rows.task_board_item_prs.map((row) =>
          prKey(row.task_board_item_id, row.url),
        ),
      );
      // An archived card someone took out and ran keeps its older history;
      // only what the run attached since the capture goes.
      const lateOnArchived = (
        await this.select(tx, "task_board_item_prs", snapshot.archivedItemIds)
      ).filter(
        (row) => Date.parse(String(row.created_at)) > capturedAt.getTime(),
      );
      const prsToClose = [
        ...(
          await this.select(tx, "task_board_item_prs", touchedItemIds)
        ).filter(
          (row) => !snapshotPrs.has(prKey(row.task_board_item_id, row.url)),
        ),
        ...lateOnArchived,
      ].flatMap((row) => prRef(row) ?? []);
      if (snapshot.archivedItemIds.length > 0) {
        for (const table of [
          "task_board_item_prs",
          "task_board_item_threads",
        ] as const) {
          await tx
            .deleteFrom(table)
            .where("task_board_item_id", "in", snapshot.archivedItemIds)
            .where("created_at", ">", capturedAt)
            .execute();
        }
      }

      const linkedThreadIds = touchedItemIds.length
        ? (
            await tx
              .selectFrom("task_board_item_threads")
              .select("thread_id")
              .where("task_board_item_id", "in", touchedItemIds)
              .execute()
          ).map((row) => row.thread_id)
        : [];
      const threadIds = [
        ...new Set([
          ...linkedThreadIds,
          ...stringIds(snapshot.rows.threads, "id"),
        ]),
      ];
      // Chats started since the capture go too; the snapshot's own come back.
      // `threads.created_at` is ISO text, which orders like the instant.
      const startedSince = sql<boolean>`created_at > ${snapshot.capturedAt}`;
      await tx
        .deleteFrom("threads")
        .where("organization_id", "=", organizationId)
        .where((eb) =>
          threadIds.length
            ? eb.or([eb("id", "in", threadIds), startedSince])
            : startedSince,
        )
        .execute();

      if (touchedItemIds.length > 0) {
        for (const table of ITEM_CHILD_TABLES) {
          await tx
            .deleteFrom(table)
            .where("task_board_item_id", "in", touchedItemIds)
            .execute();
        }
      }
      if (deletedItemIds.length > 0) {
        await tx
          .deleteFrom("task_board_items")
          .where("organization_id", "=", organizationId)
          .where("id", "in", deletedItemIds)
          .execute();
      }

      const tagIds = new Set(
        (
          await tx
            .selectFrom("organization_tags")
            .select("id")
            .where("organization_id", "=", organizationId)
            .execute()
        ).map((row) => row.id),
      );
      for (const table of SNAPSHOT_TABLES) {
        let rows = snapshot.rows[table].map((row) =>
          shiftRow(row, TABLES[table].times, shiftMs),
        );
        // A tag deleted since the capture would fail the whole restore.
        if (table === "task_board_item_tags") {
          rows = rows.filter((row) => tagIds.has(String(row.id)));
        }
        await insertRows(tx, table, rows, table === "task_board_items");
      }

      const rearchived = snapshot.archivedItemIds.length
        ? await tx
            .updateTable("task_board_items")
            .set({ status: LANES.archive, updated_at: now })
            .where("organization_id", "=", organizationId)
            .where("id", "in", snapshot.archivedItemIds)
            .where("status", "!=", LANES.archive)
            .returning("id")
            .execute()
        : [];

      return {
        previewUrls: [
          ...new Set(
            Object.values(PrCardsSchema.parse(stored.pr_cards)).flatMap(
              (cards) => cards.flatMap((card) => card.previewUrl ?? []),
            ),
          ),
        ],
        restoredItemIds: capturedIds,
        deletedItemIds,
        rearchivedItemIds: rearchived.map((row) => row.id),
        prsToClose,
      };
    });
  }
}

/** The columns `table` has now that a write may set. */
async function writableColumns(
  tx: Transaction<Database>,
  table: SnapshotTable,
): Promise<Set<string>> {
  const { rows } = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${table}
      AND is_generated = 'NEVER' AND is_identity = 'NO'
  `.execute(tx);
  return new Set(rows.map((row) => row.column_name));
}

const INSERT_CHUNK = 500;

async function insertRows(
  tx: Transaction<Database>,
  table: SnapshotTable,
  rows: Row[],
  upsert: boolean,
): Promise<void> {
  const first = rows[0];
  if (!first) return;
  const writable = await writableColumns(tx, table);
  const columns = Object.keys(first).filter((c) => writable.has(c));
  const list = sql.join(columns.map((c) => sql.ref(c)));
  const onConflict = upsert
    ? sql`ON CONFLICT (id) DO UPDATE SET ${sql.join(
        columns
          .filter((c) => c !== "id")
          .map((c) => sql`${sql.ref(c)} = EXCLUDED.${sql.ref(c)}`),
      )}`
    : sql``;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = JSON.stringify(rows.slice(i, i + INSERT_CHUNK));
    await sql`
      INSERT INTO ${sql.table(table)} (${list})
      SELECT ${list} FROM jsonb_populate_recordset(NULL::${sql.table(table)}, ${chunk}::jsonb)
      ${onConflict}
    `.execute(tx);
  }
}
