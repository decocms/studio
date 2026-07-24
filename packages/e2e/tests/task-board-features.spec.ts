import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

// Black-box wire-contract shapes (owned by this test, per e2e isolation rules).
interface TaskBoardItem {
  id: string;
  title: string;
  status: string;
  columnId: string | null;
  tags: string[];
  sprintId: string | null;
  releaseId: string | null;
}
interface Comment {
  id: string;
  parentId: string | null;
  body: string;
  attachments: { id: string; filename: string; mimeType: string }[];
}
interface Sprint {
  id: string;
  name: string;
  state: string;
}

test.describe("task board features", () => {
  test("custom columns, tags, comments, attachments, sprints, releases", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    // --- Custom board config: rename the in-progress lane, enable features. ---
    // UPDATE requires organizationId to match the path org, so resolve it first.
    const settings = await call<{ organizationId: string }>(
      "ORGANIZATION_SETTINGS_GET",
      {},
    );
    await call("ORGANIZATION_SETTINGS_UPDATE", {
      organizationId: settings.organizationId,
      task_board: {
        columns: [
          { id: "triage", name: null, stage: "triage" },
          { id: "doing", name: "Doing", stage: "in_progress" },
          { id: "done", name: null, stage: "done" },
        ],
        sprintsEnabled: true,
        releasesEnabled: true,
      },
    });

    // --- Sprint, then a task placed in the custom column with tags. ---
    const { sprint } = await call<{ sprint: Sprint }>(
      "TASK_BOARD_SPRINT_CREATE",
      { name: "Sprint 1" },
    );
    expect(sprint.state).toBe("planned");

    const { item } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      {
        title: "Ship the board",
        status: "in_progress",
        columnId: "doing",
        tags: ["backend", "urgent"],
        sprintId: sprint.id,
      },
    );
    expect(item.columnId).toBe("doing");
    expect(item.tags.sort()).toEqual(["backend", "urgent"]);
    expect(item.sprintId).toBe(sprint.id);

    // --- Comment with an image attachment, then a reply. ---
    // 1x1 transparent PNG.
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    const { comment } = await call<{ comment: Comment }>(
      "TASK_BOARD_COMMENT_CREATE",
      {
        taskBoardItemId: item.id,
        body: "First pass looks good",
        attachments: [
          {
            filename: "shot.png",
            mimeType: "image/png",
            dataBase64: pngBase64,
          },
        ],
      },
    );
    expect(comment.attachments).toHaveLength(1);
    expect(comment.attachments[0]?.filename).toBe("shot.png");

    const { comment: reply } = await call<{ comment: Comment }>(
      "TASK_BOARD_COMMENT_CREATE",
      { taskBoardItemId: item.id, parentId: comment.id, body: "Agreed" },
    );
    expect(reply.parentId).toBe(comment.id);

    const { comments } = await call<{ comments: Comment[] }>(
      "TASK_BOARD_COMMENT_LIST",
      { taskBoardItemId: item.id },
    );
    expect(comments.map((c) => c.id).sort()).toEqual(
      [comment.id, reply.id].sort(),
    );

    // A reply-to-a-reply is rejected (one level deep).
    await expect(
      call("TASK_BOARD_COMMENT_CREATE", {
        taskBoardItemId: item.id,
        parentId: reply.id,
        body: "too deep",
      }),
    ).rejects.toThrow();

    // --- Release packages the task and stamps it. ---
    const { release } = await call<{ release: { id: string; title: string } }>(
      "TASK_BOARD_RELEASE_CREATE",
      { title: "v1.0", taskIds: [item.id] },
    );
    const listed = await call<{ items: TaskBoardItem[] }>(
      "TASK_BOARD_ITEM_LIST",
      {},
    );
    const found = listed.items.find((i) => i.id === item.id);
    expect(found?.releaseId).toBe(release.id);

    // --- Deleting the sprint returns the task to the backlog. ---
    await call("TASK_BOARD_SPRINT_DELETE", { id: sprint.id });
    const afterSprintDelete = await call<{ items: TaskBoardItem[] }>(
      "TASK_BOARD_ITEM_LIST",
      {},
    );
    expect(
      afterSprintDelete.items.find((i) => i.id === item.id)?.sprintId,
    ).toBeNull();
  });
});
