import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

// Black-box wire-contract shapes (owned by this test, per e2e isolation rules).
interface TaskBoardItem {
  id: string;
}
interface Comment {
  id: string;
  taskBoardItemId: string;
  parentId: string | null;
  authorId: string | null;
  body: string;
  mentions: { kind: string; id: string }[];
  resolved: boolean;
}

test.describe("task board comments", () => {
  test("threads, replies one level deep, resolve, and cascade", async ({
    authedPage,
  }) => {
    const { page, orgSlug, user } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const { item } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Commented task" },
    );

    const { comment: root } = await call<{ comment: Comment }>(
      "TASK_BOARD_COMMENT_CREATE",
      {
        taskBoardItemId: item.id,
        body: `Ping @${user.userId}`,
        mentions: [{ kind: "user", id: user.userId }],
      },
    );
    expect(root.parentId).toBeNull();
    expect(root.authorId).toBe(user.userId);
    expect(root.resolved).toBe(false);
    expect(root.mentions).toEqual([{ kind: "user", id: user.userId }]);

    const { comment: reply } = await call<{ comment: Comment }>(
      "TASK_BOARD_COMMENT_CREATE",
      { taskBoardItemId: item.id, body: "On it", parentId: root.id },
    );
    expect(reply.parentId).toBe(root.id);

    // Threads are one level deep: a reply can't be replied to.
    await expect(
      call("TASK_BOARD_COMMENT_CREATE", {
        taskBoardItemId: item.id,
        body: "Nested",
        parentId: reply.id,
      }),
    ).rejects.toThrow(/one level/);

    // A thread settles as a whole — only its root carries the flag.
    const { comment: resolved } = await call<{ comment: Comment }>(
      "TASK_BOARD_COMMENT_UPDATE",
      { id: root.id, resolved: true },
    );
    expect(resolved.resolved).toBe(true);
    await expect(
      call("TASK_BOARD_COMMENT_UPDATE", { id: reply.id, resolved: true }),
    ).rejects.toThrow(/thread root/);

    const { comment: edited } = await call<{ comment: Comment }>(
      "TASK_BOARD_COMMENT_UPDATE",
      { id: reply.id, body: "Done" },
    );
    expect(edited.body).toBe("Done");

    const listed = await call<{ comments: Comment[] }>(
      "TASK_BOARD_COMMENT_LIST",
      { taskBoardItemId: item.id },
    );
    expect(listed.comments.map((c) => c.body)).toEqual([
      `Ping @${user.userId}`,
      "Done",
    ]);

    // Deleting a root takes its replies with it.
    await call("TASK_BOARD_COMMENT_DELETE", { id: root.id });
    const afterDelete = await call<{ comments: Comment[] }>(
      "TASK_BOARD_COMMENT_LIST",
      { taskBoardItemId: item.id },
    );
    expect(afterDelete.comments).toEqual([]);

    // Deleting the task cascades whatever is left.
    await call("TASK_BOARD_COMMENT_CREATE", {
      taskBoardItemId: item.id,
      body: "Survivor?",
    });
    await call("TASK_BOARD_ITEM_DELETE", { id: item.id });
    const afterTaskDelete = await call<{ comments: Comment[] }>(
      "TASK_BOARD_COMMENT_LIST",
      { taskBoardItemId: item.id },
    );
    expect(afterTaskDelete.comments).toEqual([]);
  });

  test("a task in another org can't be commented on", async ({
    authedPage,
  }) => {
    const { page, orgSlug, user } = authedPage;
    const request = page.context().request;

    // A second org the same user owns: the task is reachable, just not through
    // the first org's slug — the scope, not the membership, is what gates it.
    const otherSlug = `${orgSlug}-other`;
    await callSelfMcpTool(request, orgSlug, "ORGANIZATION_CREATE", {
      slug: otherSlug,
      name: `Other ${user.userId}`,
    });
    const { item } = await callSelfMcpTool<{ item: TaskBoardItem }>(
      request,
      otherSlug,
      "TASK_BOARD_ITEM_CREATE",
      { title: "Other org task" },
    );

    await expect(
      callSelfMcpTool(request, orgSlug, "TASK_BOARD_COMMENT_CREATE", {
        taskBoardItemId: item.id,
        body: "Cross-tenant",
      }),
    ).rejects.toThrow(/not found/);
    // …and it isn't readable through the wrong slug either.
    const { comments } = await callSelfMcpTool<{ comments: Comment[] }>(
      request,
      orgSlug,
      "TASK_BOARD_COMMENT_LIST",
      { taskBoardItemId: item.id },
    );
    expect(comments).toEqual([]);
  });
});
