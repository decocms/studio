import type { Kysely } from "kysely";
import type { Database } from "./types";
import { DEFAULT_BOARD_PROMPTS } from "./task-board-default-prompts";

/** Board prompt scopes: `columnKey` null is org-wide, otherwise one column.
 *  A lane with no row carries its `DEFAULT_BOARD_PROMPTS` entry; a blank row
 *  is a lane the org cleared. */
export interface TaskBoardPrompt {
  columnKey: string | null;
  prompt: string;
  skills: string[];
}

type Row = { column_key: string | null; prompt: string; skills: string[] };

/** Deterministic primary key, so an upsert is `ON CONFLICT (id)` and the
 *  org-wide row cannot be inserted twice. `""` is not a column key any board
 *  has, so it is free to stand for "every column" here. */
const rowId = (organizationId: string, columnKey: string | null) =>
  `tbp_${organizationId}_${columnKey ?? ""}`;

export class TaskBoardPromptStorage {
  constructor(private readonly db: Kysely<Database>) {}

  /** Every scope in effect for this org, defaults included, org-wide first. */
  async listByOrg(organizationId: string): Promise<TaskBoardPrompt[]> {
    const rows = await this.db
      .selectFrom("task_board_prompts")
      .select(["column_key", "prompt", "skills"])
      .where("organization_id", "=", organizationId)
      .orderBy("column_key", "asc")
      .execute();
    const set: TaskBoardPrompt[] = (rows as Row[]).map((r) => ({
      columnKey: r.column_key,
      prompt: r.prompt,
      skills: r.skills,
    }));
    const unset = DEFAULT_BOARD_PROMPTS.filter(
      (d) => !set.some((p) => p.columnKey === d.columnKey),
    );
    return [...set, ...unset].sort((a, b) =>
      a.columnKey === null ? -1 : b.columnKey === null ? 1 : 0,
    );
  }

  /** The org-wide and `columnKey` scopes, composed for one run. */
  async promptFor(
    organizationId: string,
    columnKey: string | null,
  ): Promise<string | undefined> {
    const scoped = (await this.listByOrg(organizationId)).filter(
      (p) => p.columnKey === null || p.columnKey === columnKey,
    );
    return composeBoardPrompt(scoped);
  }

  /** Set a scope's fields; omitted `skills` keeps the existing ones. */
  async upsert(
    organizationId: string,
    columnKey: string | null,
    fields: { prompt: string; skills?: string[] },
  ): Promise<TaskBoardPrompt> {
    const row = await this.db
      .insertInto("task_board_prompts")
      .values({
        id: rowId(organizationId, columnKey),
        organization_id: organizationId,
        column_key: columnKey,
        prompt: fields.prompt,
        skills: fields.skills ?? defaultFor(columnKey)?.skills ?? [],
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          prompt: fields.prompt,
          ...(fields.skills ? { skills: fields.skills } : {}),
          updated_at: new Date(),
        }),
      )
      .returning(["prompt", "skills"])
      .executeTakeFirstOrThrow();
    return { columnKey, prompt: row.prompt, skills: row.skills };
  }

  /** Clear a scope. A defaulted lane keeps a blank row, or the default would
   *  come back. Returns whether there was anything to clear. */
  async remove(
    organizationId: string,
    columnKey: string | null,
  ): Promise<boolean> {
    if (defaultFor(columnKey)) {
      const current = (await this.listByOrg(organizationId)).find(
        (p) => p.columnKey === columnKey,
      );
      if (!current?.prompt && !current?.skills.length) return false;
      await this.upsert(organizationId, columnKey, { prompt: "", skills: [] });
      return true;
    }
    const result = await this.db
      .deleteFrom("task_board_prompts")
      .where("id", "=", rowId(organizationId, columnKey))
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }
}

const defaultFor = (columnKey: string | null) =>
  DEFAULT_BOARD_PROMPTS.find((d) => d.columnKey === columnKey);

/** Scopes' prompts in order, then one line naming their skills. */
export function composeBoardPrompt(
  scopes: Pick<TaskBoardPrompt, "prompt" | "skills">[],
): string | undefined {
  const parts = scopes.map((p) => p.prompt.trim()).filter(Boolean);
  const skills = [...new Set(scopes.flatMap((p) => p.skills))];
  if (skills.length > 0) {
    parts.push(
      `Skills configured for this work — load each one with the skill tool before you start: ${skills.join(", ")}`,
    );
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
