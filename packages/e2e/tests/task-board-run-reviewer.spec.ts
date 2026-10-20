import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

// Black-box wire-contract shapes (owned by this test, per e2e isolation rules).
interface TaskBoardItem {
  id: string;
}

/**
 * `TASK_BOARD_RUN_REVIEWER` is the per-card override for an org that turned
 * automated review off. Its refusals are what this asserts: they are the two
 * states a human can act on, they cost no agent run, and they are the whole
 * reason the tool does not just dispatch whatever it is handed.
 *
 * The dispatching path is deliberately not exercised here — it spends a real
 * agent run, and the guards it reuses (`reviewerHandledThisCycle`, the attempt
 * cap, the fence) are unit-tested in `enqueue-reviewer.test.ts`.
 */
test.describe("task board run reviewer", () => {
  test("refuses a card with no pull request to review", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const { item } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Nothing to review yet", status: "in_review" },
    );

    await expect(
      call("TASK_BOARD_RUN_REVIEWER", { id: item.id }),
    ).rejects.toThrow(/no pull request to review/i);
  });

  test("refuses a task board item that does not exist", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;

    await expect(
      callSelfMcpTool(request, orgSlug, "TASK_BOARD_RUN_REVIEWER", {
        id: "board_does_not_exist",
      }),
    ).rejects.toThrow(/not found/i);
  });
});
