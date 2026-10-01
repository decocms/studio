import type { Kysely } from "kysely";
import type { Database } from "./types";

/** Board prompt scopes: `columnKey` null is org-wide, otherwise one column. */
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

  /** Every prompt this org has set, org-wide row first. */
  async listByOrg(organizationId: string): Promise<TaskBoardPrompt[]> {
    const rows = await this.db
      .selectFrom("task_board_prompts")
      .select(["column_key", "prompt", "skills"])
      .where("organization_id", "=", organizationId)
      .orderBy("column_key", "asc")
      .execute();
    return (rows as Row[])
      .map((r) => ({
        columnKey: r.column_key,
        prompt: r.prompt,
        skills: r.skills,
      }))
      .sort((a, b) =>
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
        skills: fields.skills ?? [],
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
