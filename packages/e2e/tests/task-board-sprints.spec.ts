import { callSelfMcpTool, findOrgId } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

// Black-box wire-contract shapes (owned by this test, per e2e isolation rules).
interface TaskBoardItem {
  id: string;
  title: string;
  sprintId: string | null;
}
interface Sprint {
  id: string;
  name: string;
  state: "active" | "future" | "closed";
  startsAt: string | null;
  endsAt: string | null;
}
interface BoardList {
  items: TaskBoardItem[];
  sprints: Sprint[];
}

/**
 * Sprints are mirrored from the tracker the board syncs with, never authored
 * here. Which sprint a card is IN is a different question, and one Studio now
 * answers: pulling a card out of the backlog is a thing a person does here and
 * the sync pushes onward.
 *
 * An org with no Jira connected has no sprints, which is exactly the state
 * under test — so what this tier reaches is the shape of the contract and the
 * refusals. That a real sprint sticks is the sync's own ground, covered by
 * `rewritesSprint` and the push workflow.
 */
test.describe("task board sprints", () => {
  test("the board read carries a sprint list, and every card names its sprint", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const { item } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Backlog task" },
    );
    expect(item.sprintId).toBe(null);

    const board = await call<BoardList>("TASK_BOARD_ITEM_LIST", {});
    // The filter's option set ships with the items, so it is always present.
    expect(Array.isArray(board.sprints)).toBe(true);
    expect(board.sprints).toEqual([]);
    const listed = board.items.find((i) => i.id === item.id);
    expect(listed).toBeDefined();
    expect(listed?.sprintId).toBe(null);
  });

  /** A card is born in the backlog. Create takes no sprint, under either the
   *  old input name or the column's own: planning is a move, not a birth. */
  test("a card cannot be created straight into a sprint", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const { item: created } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Tries to plan itself", sprint: 2, sprintId: "sprint_made_up" },
    );
    expect(created.sprintId).toBe(null);

    const board = await call<BoardList>("TASK_BOARD_ITEM_LIST", {});
    expect(board.items.find((i) => i.id === created.id)?.sprintId).toBe(null);
  });

  /**
   * Inverted from "a card's sprint cannot be set from Studio". It can now, and
   * that is the point of the backlog screen. What must not happen is a card
   * pointing at a sprint that does not exist, and the refusal has to say so in
   * words rather than leak `violates foreign key constraint
   * "task_board_items_sprint_id_fkey"` at whoever asked.
   */
  test("a sprint this board does not have is refused, in words", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const { item } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Waiting to be planned" },
    );

    await expect(
      call("TASK_BOARD_ITEM_UPDATE", {
        id: item.id,
        sprintId: "sprint_made_up",
      }),
    ).rejects.toThrow(/not a sprint on this board/);

    const board = await call<BoardList>("TASK_BOARD_ITEM_LIST", {});
    expect(board.items.find((i) => i.id === item.id)?.sprintId).toBe(null);
  });

  /** Null is the backlog, and always a place a card may go — it needs no
   *  sprint to exist, so it works on a board that has none. */
  test("sending a card back to the backlog is always allowed", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const { item } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Already in the backlog" },
    );
    const { item: updated } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_UPDATE",
      { id: item.id, sprintId: null },
    );
    expect(updated.sprintId).toBe(null);
  });

  /** The cadence write used to replace a stored `sprint_config` whole. There is
   *  nothing left for it to replace, and it must still succeed. */
  test("org settings no longer carry a sprint cadence", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);
    const orgId = await findOrgId(request, orgSlug);

    const settings = await call<Record<string, unknown>>(
      "ORGANIZATION_SETTINGS_GET",
      {},
    );
    expect("sprint_config" in settings).toBe(false);

    await call("ORGANIZATION_SETTINGS_UPDATE", {
      organizationId: orgId,
      sprint_config: { enabled: true, weeks: 2, startDate: "2026-01-05" },
    });
    const after = await call<Record<string, unknown>>(
      "ORGANIZATION_SETTINGS_GET",
      {},
    );
    expect("sprint_config" in after).toBe(false);
  });
});
