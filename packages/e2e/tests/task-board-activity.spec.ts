import type { Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

interface TaskBoardItem {
  id: string;
  title: string;
  status: string;
}

interface TaskBoardActivity {
  id: string;
  kind: string;
  actorId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

test.describe("task board activity timeline", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();
  });

  test.afterAll(async () => {
    await db?.end();
  });

  test("records created and status_changed events oldest-first", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;

    const created = await callSelfMcpTool<{ item: TaskBoardItem }>(
      request,
      orgSlug,
      "TASK_BOARD_ITEM_CREATE",
      { title: "Track my changes", status: "todo" },
    );
    const itemId = created.item.id;

    // A fresh task has exactly one activity event: its creation.
    const afterCreate = await callSelfMcpTool<{
      activity: TaskBoardActivity[];
    }>(request, orgSlug, "TASK_BOARD_ACTIVITY_LIST", {
      taskBoardItemId: itemId,
    });
    expect(afterCreate.activity.map((a) => a.kind)).toEqual(["created"]);

    // Moving the task logs a status_changed event carrying { from, to }.
    await callSelfMcpTool<{ item: TaskBoardItem }>(
      request,
      orgSlug,
      "TASK_BOARD_ITEM_UPDATE",
      { id: itemId, status: "in_progress" },
    );

    const afterMove = await callSelfMcpTool<{ activity: TaskBoardActivity[] }>(
      request,
      orgSlug,
      "TASK_BOARD_ACTIVITY_LIST",
      { taskBoardItemId: itemId },
    );
    // Oldest first: creation, then the move.
    expect(afterMove.activity.map((a) => a.kind)).toEqual([
      "created",
      "status_changed",
    ]);
    const move = afterMove.activity[1]!;
    expect(move.data).toMatchObject({ from: "todo", to: "in_progress" });

    // A no-op update (same status) must not append a spurious event.
    await callSelfMcpTool<{ item: TaskBoardItem }>(
      request,
      orgSlug,
      "TASK_BOARD_ITEM_UPDATE",
      { id: itemId, status: "in_progress" },
    );
    const afterNoop = await callSelfMcpTool<{ activity: TaskBoardActivity[] }>(
      request,
      orgSlug,
      "TASK_BOARD_ACTIVITY_LIST",
      { taskBoardItemId: itemId },
    );
    expect(afterNoop.activity).toHaveLength(2);

    await callSelfMcpTool(request, orgSlug, "TASK_BOARD_ITEM_DELETE", {
      id: itemId,
    });
  });
});
