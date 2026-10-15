/**
 * The board's lanes over the wire: the lanes a card can rest in, the previous
 * board's lanes being refused, and the ship gate that only Ready for
 * Deployment passes.
 *
 * What the agents do in each lane (the reviewer moving an approval to QA, a
 * run kept out of the people's checks) is asserted at the integration tier
 * (`board-lanes.integration.test.ts`): it needs a review run, which this tier
 * does not have.
 */

import { callSelfMcpTool, findOrgId } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

// Black-box wire-contract shapes (owned by this test, per e2e isolation rules).
interface TaskBoardItem {
  id: string;
  title: string;
  status: string;
}
interface Activity {
  action: string;
  data: Record<string, unknown>;
}

const FLOW = [
  "todo",
  "in_progress",
  "in_review",
  "qa",
  "customer_approval",
  "ready_for_deployment",
  "post_deploy_validation",
  "done",
];

test.describe("task board lanes", () => {
  test("a card moves through every lane and the timeline says so", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const { item } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Rides the whole board" },
    );
    expect(item.status).toBe("triage");

    for (const status of FLOW) {
      const { item: moved } = await call<{ item: TaskBoardItem }>(
        "TASK_BOARD_ITEM_UPDATE",
        { id: item.id, status },
      );
      expect(moved.status).toBe(status);
    }

    // The UI draws columns from this read, so it has to carry every lane.
    const { items, columns } = await call<{
      items: TaskBoardItem[];
      columns: { key: string }[];
    }>("TASK_BOARD_ITEM_LIST", {});
    expect(items.find((i) => i.id === item.id)?.status).toBe("done");
    for (const status of FLOW) {
      expect(columns.map((c) => c.key)).toContain(status);
    }

    const { activity } = await call<{ activity: Activity[] }>(
      "TASK_BOARD_ACTIVITY_LIST",
      { taskBoardItemId: item.id },
    );
    const lanes = activity
      .filter((a) => a.action === "status_changed")
      .map((a) => a.data.to);
    expect(lanes).toEqual(FLOW);
  });

  test("the previous board's lanes are refused", async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const { item } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Stays on the new board" },
    );
    for (const status of ["approved", "merged"]) {
      await expect(
        call("TASK_BOARD_ITEM_UPDATE", { id: item.id, status }),
      ).rejects.toThrow();
      await expect(
        call("TASK_BOARD_ITEM_CREATE", { title: "old lane", status }),
      ).rejects.toThrow();
    }
  });

  test("the ship gate passes Ready for Deployment and nothing before it", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);
    const orgId = await findOrgId(request, orgSlug);

    // Merging on arrival would try to merge the card created below.
    await call("ORGANIZATION_SETTINGS_UPDATE", {
      organizationId: orgId,
      flags: { auto_merge: false },
    });

    for (const status of ["in_review", "qa", "customer_approval"]) {
      const { item: early } = await call<{ item: TaskBoardItem }>(
        "TASK_BOARD_ITEM_CREATE",
        { title: `Still in ${status}`, status },
      );
      await expect(
        call("TASK_BOARD_PROMOTE_TO_PRODUCTION", { taskBoardItemId: early.id }),
      ).rejects.toThrow(/not ready to ship/i);
    }

    // The gate must let this THROUGH; the merge then has no pull request.
    // Explicit catch, not `.rejects.not.toThrow` — that passes vacuously.
    const { item: cleared } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Cleared for release", status: "ready_for_deployment" },
    );
    const shipError = await call<{ status: string; merged: boolean }>(
      "TASK_BOARD_PROMOTE_TO_PRODUCTION",
      { taskBoardItemId: cleared.id },
    ).then(
      (result) => (result.merged ? "merged" : ""),
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    expect(shipError).not.toMatch(/not ready to ship/i);
  });
});
