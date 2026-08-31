import type { Kysely } from "kysely";
import type { Database } from "./types";

/**
 * Instructions appended to the system prompt of every agent run dispatched
 * from a board card (migration 197).
 *
 * `columnKey` null is the org-wide row — the one Settings → Tasks writes. A
 * non-null key scopes the same text to cards in one column; nothing writes one
 * yet, so `promptFor` only ever finds the org-wide row today.
 */
export interface TaskBoardPrompt {
  columnKey: string | null;
  prompt: string;
}

type Row = { column_key: string | null; prompt: string };

/** Deterministic primary key, so an upsert is `ON CONFLICT (id)` and the
 *  org-wide row cannot be inserted twice. `""` is not a column key any board
 *  has, so it is free to stand for "every column" here. */
const rowId = (organizationId: string, columnKey: string | null) =>
  `tbp_${organizationId}_${columnKey ?? ""}`;

export class TaskBoardPromptStorage {
  constructor(private readonly db: Kysely<Database>) {}

  /** Every prompt this org has set, org-wide row first. */
  async listByOrg(organizationId: string): Promise<TaskBoardPrompt[]> {
    const rows = await this.db
      .selectFrom("task_board_prompts")
      .select(["column_key", "prompt"])
      .where("organization_id", "=", organizationId)
      .orderBy("column_key", "asc")
      .execute();
    return (rows as Row[])
      .map((r) => ({ columnKey: r.column_key, prompt: r.prompt }))
      .sort((a, b) =>
        a.columnKey === null ? -1 : b.columnKey === null ? 1 : 0,
      );
  }

  /**
   * What a run on `columnKey` should carry: the org-wide text, then the
   * column's own if it has one. One query, because the dispatch path runs it
   * per run and both rows live in the same org partition.
   */
  async promptFor(
    organizationId: string,
    columnKey: string | null,
  ): Promise<string | undefined> {
    const all = await this.listByOrg(organizationId);
    const parts = all
      .filter((p) => p.columnKey === null || p.columnKey === columnKey)
      .map((p) => p.prompt.trim())
      .filter(Boolean);
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }

  /** Set the prompt, replacing whatever was on that scope. */
  async upsert(
    organizationId: string,
    columnKey: string | null,
    prompt: string,
  ): Promise<TaskBoardPrompt> {
    await this.db
      .insertInto("task_board_prompts")
      .values({
        id: rowId(organizationId, columnKey),
        organization_id: organizationId,
        column_key: columnKey,
        prompt,
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({ prompt, updated_at: new Date() }),
      )
      .execute();
    return { columnKey, prompt };
  }

  /** Clear the prompt on a scope. Deleting IS the off switch — an empty row
   *  and no row would otherwise mean the same thing in two ways. Returns
   *  whether there was one. */
  async remove(
    organizationId: string,
    columnKey: string | null,
  ): Promise<boolean> {
    const result = await this.db
      .deleteFrom("task_board_prompts")
      .where("id", "=", rowId(organizationId, columnKey))
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }
}
