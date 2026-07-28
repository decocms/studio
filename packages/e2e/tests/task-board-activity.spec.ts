import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

// Black-box wire-contract shapes (owned by this test, per e2e isolation rules).
interface TaskBoardItem {
  id: string;
  status: string;
  assigneeId: string | null;
}
interface Activity {
  id: string;
  kind: string;
  actorId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

test.describe("task board activity log", () => {
  test("records create, status and assignee changes in order", async ({
    authedPage,
  }) => {
    const { page, orgSlug, user } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const { item } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Activity log task" },
    );

    await call("TASK_BOARD_ITEM_UPDATE", {
      id: item.id,
      status: "in_progress",
    });
    // A title-only edit must NOT show up in the timeline.
    await call("TASK_BOARD_ITEM_UPDATE", { id: item.id, title: "Renamed" });
    await call("TASK_BOARD_ITEM_UPDATE", {
      id: item.id,
      assigneeId: user.userId,
    });

    const { activity } = await call<{ activity: Activity[] }>(
      "TASK_BOARD_ACTIVITY_LIST",
      { taskBoardItemId: item.id },
    );

    expect(activity.map((a) => a.kind)).toEqual([
      "created",
      "status_changed",
      "assignee_changed",
    ]);
    expect(activity[1]?.data).toMatchObject({
      from: "triage",
      to: "in_progress",
    });
    expect(activity[2]?.data).toMatchObject({
      from: null,
      to: user.userId,
    });
    // Every event is attributed to the acting user.
    for (const a of activity) expect(a.actorId).toBe(user.userId);

    // Deleting the task cascades its timeline away.
    await call("TASK_BOARD_ITEM_DELETE", { id: item.id });
    const after = await call<{ activity: Activity[] }>(
      "TASK_BOARD_ACTIVITY_LIST",
      { taskBoardItemId: item.id },
    );
    expect(after.activity).toEqual([]);
  });
});
