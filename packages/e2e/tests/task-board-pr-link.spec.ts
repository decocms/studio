import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

// Black-box wire-contract shapes (owned by this test, per e2e isolation rules).
interface TaskBoardItem {
  id: string;
  status: string;
}
interface TaskBoardItemPr {
  url: string;
  number: number;
  repoOwner: string;
  repoName: string;
}

test.describe("task board PR linking via create/update", () => {
  test("creates a card in review with the PR attached in one call", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const prUrl = "https://github.com/acme-e2e/widget/pull/4242";
    const { item } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Ship the widget", status: "in_review", prUrl },
    );
    expect(item.status).toBe("in_review");

    const { prs } = await call<{ prs: TaskBoardItemPr[] }>(
      "TASK_BOARD_ITEM_PRS_GET",
      { taskBoardItemId: item.id },
    );
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      url: prUrl,
      number: 4242,
      repoOwner: "acme-e2e",
      repoName: "widget",
    });
  });

  test("links a PR to an existing card on update", async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const { item } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Existing card" },
    );

    const prUrl = "https://github.com/acme-e2e/widget/pull/77";
    const { item: updated } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_UPDATE",
      { id: item.id, status: "in_review", prUrl },
    );
    expect(updated.status).toBe("in_review");

    const { prs } = await call<{ prs: TaskBoardItemPr[] }>(
      "TASK_BOARD_ITEM_PRS_GET",
      { taskBoardItemId: item.id },
    );
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ url: prUrl, number: 77 });
  });

  test("rejects a URL that is not a GitHub pull request", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    await expect(
      call("TASK_BOARD_ITEM_CREATE", {
        title: "Bad link",
        prUrl: "https://github.com/acme-e2e/widget/issues/9",
      }),
    ).rejects.toThrow(/not a github pull request url/i);
  });
});
