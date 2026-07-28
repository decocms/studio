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
  test("records every field change in order", async ({ authedPage }) => {
    const { page, orgSlug, user } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const { item } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Activity log task" },
    );

    const due = "2026-09-01T23:59:59.000Z";
    await call("TASK_BOARD_ITEM_UPDATE", {
      id: item.id,
      status: "in_progress",
    });
    await call("TASK_BOARD_ITEM_UPDATE", {
      id: item.id,
      assigneeId: user.userId,
    });
    await call("TASK_BOARD_ITEM_UPDATE", { id: item.id, priority: "urgent" });
    await call("TASK_BOARD_ITEM_UPDATE", { id: item.id, dueDate: due });
    await call("TASK_BOARD_ITEM_UPDATE", { id: item.id, title: "Renamed" });
    await call("TASK_BOARD_ITEM_UPDATE", { id: item.id, description: "Body" });
    // Clearing counts as a change; re-sending the same value does not.
    await call("TASK_BOARD_ITEM_UPDATE", {
      id: item.id,
      assigneeId: null,
      dueDate: null,
    });
    await call("TASK_BOARD_ITEM_UPDATE", { id: item.id, title: "Renamed" });
    // Drag-to-reorder is deliberately not logged.
    await call("TASK_BOARD_ITEM_UPDATE", { id: item.id, sortOrder: 42 });

    const { activity } = await call<{ activity: Activity[] }>(
      "TASK_BOARD_ACTIVITY_LIST",
      { taskBoardItemId: item.id },
    );

    expect(activity.map((a) => a.kind)).toEqual([
      "created",
      "status_changed",
      "assignee_changed",
      "priority_changed",
      "due_date_changed",
      "title_changed",
      "description_changed",
      "assignee_changed",
      "due_date_changed",
    ]);
    expect(activity[1]?.data).toMatchObject({
      from: "triage",
      to: "in_progress",
    });
    expect(activity[2]?.data).toMatchObject({ from: null, to: user.userId });
    expect(activity[3]?.data).toMatchObject({ from: "medium", to: "urgent" });
    expect(activity[4]?.data).toMatchObject({ from: null, to: due });
    expect(activity[5]?.data).toMatchObject({
      from: "Activity log task",
      to: "Renamed",
    });
    // A description edit records that it changed, not the body itself.
    expect(activity[6]?.data).toEqual({});
    expect(activity[7]?.data).toMatchObject({ from: user.userId, to: null });
    expect(activity[8]?.data).toMatchObject({ from: due, to: null });
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
