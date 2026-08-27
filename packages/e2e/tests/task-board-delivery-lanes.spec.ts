/**
 * The delivery lanes over the wire: the flag that gates them, the lanes a card
 * can actually rest in, and the ship gate that has to accept Approved.
 *
 * The zero-behaviour-change property (a merged PR lands on Done with the flag
 * off, Merged with it on) is asserted at the unit tier against `shippedLane`
 * and each ship site's own test — proving it here would need a real merged pull
 * request on GitHub, which this tier does not have.
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
interface OrgSettings {
  organizationId: string;
  flags: Record<string, boolean> | null;
}

const DELIVERY_LANES = ["approved", "merged", "post_deploy_validation"];

test.describe("task board delivery lanes", () => {
  test("the flag round-trips without disturbing its neighbours", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);
    const orgId = await findOrgId(request, orgSlug);

    // Unset is the default, and it reads as off.
    const before = await call<OrgSettings>("ORGANIZATION_SETTINGS_GET", {});
    expect(before.flags?.delivery_lanes_enabled ?? false).toBe(false);

    await call("ORGANIZATION_SETTINGS_UPDATE", {
      organizationId: orgId,
      flags: { auto_merge: true },
    });
    await call("ORGANIZATION_SETTINGS_UPDATE", {
      organizationId: orgId,
      flags: { delivery_lanes_enabled: true },
    });
    const on = await call<OrgSettings>("ORGANIZATION_SETTINGS_GET", {});
    expect(on.flags?.delivery_lanes_enabled).toBe(true);
    // Flags shallow-merge, so turning the lanes on must not clear a neighbour.
    expect(on.flags?.auto_merge).toBe(true);

    // An explicit false persists — it is not the same as unset.
    await call("ORGANIZATION_SETTINGS_UPDATE", {
      organizationId: orgId,
      flags: { delivery_lanes_enabled: false },
    });
    const off = await call<OrgSettings>("ORGANIZATION_SETTINGS_GET", {});
    expect(off.flags?.delivery_lanes_enabled).toBe(false);
  });

  test("a card moves through the delivery lanes and the timeline says so", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);
    const orgId = await findOrgId(request, orgSlug);

    // A direct write into a delivery lane is gated behind the flag.
    await call("ORGANIZATION_SETTINGS_UPDATE", {
      organizationId: orgId,
      flags: { delivery_lanes_enabled: true },
    });

    const { item } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Rides the delivery lanes", status: "in_review" },
    );

    for (const status of DELIVERY_LANES) {
      const { item: moved } = await call<{ item: TaskBoardItem }>(
        "TASK_BOARD_ITEM_UPDATE",
        { id: item.id, status },
      );
      expect(moved.status).toBe(status);
    }
    const { item: finished } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_UPDATE",
      { id: item.id, status: "done" },
    );
    expect(finished.status).toBe("done");

    // The UI draws columns from this read, so it has to carry the lane too.
    const { items } = await call<{ items: TaskBoardItem[] }>(
      "TASK_BOARD_ITEM_LIST",
      {},
    );
    expect(items.find((i) => i.id === item.id)?.status).toBe("done");

    const { activity } = await call<{ activity: Activity[] }>(
      "TASK_BOARD_ACTIVITY_LIST",
      { taskBoardItemId: item.id },
    );
    const lanes = activity
      .filter((a) => a.action === "status_changed")
      .map((a) => a.data.to);
    expect(lanes).toEqual([...DELIVERY_LANES, "done"]);
  });

  test("the ship gate accepts Approved and still refuses an unreviewed lane", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);
    const orgId = await findOrgId(request, orgSlug);

    // No reviewers enabled, so the readiness gate reduces to the lane alone.
    await call("ORGANIZATION_SETTINGS_UPDATE", {
      organizationId: orgId,
      flags: { qa_agent_enabled: false, code_reviewer_enabled: false },
    });

    const { item: early } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Not reviewed yet", status: "todo" },
    );
    await expect(
      call("TASK_BOARD_PROMOTE_TO_PRODUCTION", { taskBoardItemId: early.id }),
    ).rejects.toThrow(/not ready to ship/i);

    // The gate must let this THROUGH; it then fails on the missing pull request.
    // Explicit catch, not `.rejects.not.toThrow` — that passes vacuously.
    const { item: approved } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Parked in Approved", status: "approved" },
    );
    // Resolving means the gate let it through; the empty string keeps the
    // matcher on a string either way, since `.not.toMatch(null)` throws rather
    // than passing and would fail the very case this asserts.
    const shipError = await call("TASK_BOARD_PROMOTE_TO_PRODUCTION", {
      taskBoardItemId: approved.id,
    }).then(
      () => "",
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    expect(shipError).not.toMatch(/not ready to ship/i);
  });
});
