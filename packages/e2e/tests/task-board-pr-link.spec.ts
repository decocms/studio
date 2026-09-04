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

  /**
   * The board is provider-neutral: a GitLab merge request links exactly the
   * way a GitHub pull request does. The nested namespace is the point — it is
   * the shape the old `owner`/`repo` pair could not represent, and every
   * namespace level has to survive into `repoOwner`.
   */
  test("links a GitLab merge request nested in subgroups", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const prUrl =
      "https://gitlab.com/acme-e2e/team/storefront/-/merge_requests/12";
    const { item } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Ship the storefront", status: "in_review", prUrl },
    );

    const { prs } = await call<{ prs: TaskBoardItemPr[] }>(
      "TASK_BOARD_ITEM_PRS_GET",
      { taskBoardItemId: item.id },
    );
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      url: prUrl,
      number: 12,
      repoOwner: "acme-e2e/team",
      repoName: "storefront",
    });
  });

  /** A browser link to the merge request's own sub-page still names it. */
  test("accepts a merge request URL carrying a sub-path", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const { item } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      {
        title: "Diffs link",
        prUrl: "https://gitlab.com/acme-e2e/shop/-/merge_requests/5/diffs",
      },
    );
    const { prs } = await call<{ prs: TaskBoardItemPr[] }>(
      "TASK_BOARD_ITEM_PRS_GET",
      { taskBoardItemId: item.id },
    );
    expect(prs[0]).toMatchObject({
      url: "https://gitlab.com/acme-e2e/shop/-/merge_requests/5",
      number: 5,
    });
  });

  test("rejects a URL that names no change request", async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    for (const prUrl of [
      "https://github.com/acme-e2e/widget/issues/9",
      "https://gitlab.com/acme-e2e/widget/-/issues/9",
      "https://github.com/acme-e2e/widget",
    ]) {
      await expect(
        call("TASK_BOARD_ITEM_CREATE", { title: "Bad link", prUrl }),
      ).rejects.toThrow(/not a change request url/i);
    }
  });
});
