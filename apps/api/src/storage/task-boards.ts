import type { BoardType } from "@decocms/shared/task-board";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";
import { type Kysely, sql } from "kysely";
import type { Database } from "./types";

/**
 * The board of `type` for a project, or for the organization itself when
 * `virtualMcpId` is null; created on first use. The caller checks the
 * project is the organization's.
 */
export async function ensureBoard(
  db: Kysely<Database>,
  scope: {
    organizationId: string;
    virtualMcpId: string | null;
    type: BoardType;
  },
): Promise<string> {
  const inserted = await db
    .insertInto("task_boards")
    .values({
      id: generatePrefixedId("tboard"),
      organization_id: scope.organizationId,
      virtual_mcp_id: scope.virtualMcpId,
      type: scope.type,
    })
    .onConflict((oc) =>
      oc.columns(["organization_id", "virtual_mcp_id", "type"]).doNothing(),
    )
    .returning("id")
    .executeTakeFirst();
  if (inserted) return inserted.id;
  const existing = await db
    .selectFrom("task_boards")
    .select("id")
    .where("organization_id", "=", scope.organizationId)
    .where(
      sql<boolean>`virtual_mcp_id is not distinct from ${scope.virtualMcpId}`,
    )
    .where("type", "=", scope.type)
    .executeTakeFirstOrThrow();
  return existing.id;
}

/**
 * Move the cards on a project's boards to the organization's board of the
 * same type, before the project goes. Its boards then go with it
 * (`ON DELETE CASCADE`); a card left on one would block the delete.
 */
export async function releaseProjectBoards(
  db: Kysely<Database>,
  virtualMcpId: string,
): Promise<void> {
  const boards = await db
    .selectFrom("task_boards")
    .select(["id", "organization_id", "type"])
    .where("virtual_mcp_id", "=", virtualMcpId)
    .execute();
  for (const board of boards) {
    const target = await ensureBoard(db, {
      organizationId: board.organization_id,
      virtualMcpId: null,
      type: board.type,
    });
    await db
      .updateTable("task_board_items")
      .set({ board_id: target, virtual_mcp_id: null })
      .where("board_id", "=", board.id)
      .execute();
  }
}
