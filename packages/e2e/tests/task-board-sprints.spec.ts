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
 * here — so what this tier can assert is the shape of that contract and the
 * fact that nothing in Studio can write a card into a sprint. An org with no
 * Jira connected has no sprints, which is exactly the state under test.
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

  /** Both the old input name and the column's own: accepting either would let a
   *  card point at a sprint the tracker never put it in. */
  test("a card's sprint cannot be set from Studio, however it is spelled", async ({
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

    const { item: updated } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_UPDATE",
      { id: created.id, sprint: 5, sprintId: "sprint_made_up" },
    );
    expect(updated.sprintId).toBe(null);

    const board = await call<BoardList>("TASK_BOARD_ITEM_LIST", {});
    expect(board.items.find((i) => i.id === created.id)?.sprintId).toBe(null);
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
