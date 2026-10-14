/**
 * The built-in Reviewer over the wire: every org has it on In Review with the
 * "pull request ready for review" starter, its switch is the org's review
 * flag, and a review it is asked for runs through the automation fire
 * workflow like any automation.
 *
 * The review run itself needs a sandbox this tier does not have, so the fire
 * is asserted by the workflow that ran it.
 */

import type { Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool, findOrgId } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

// Black-box wire-contract shapes (owned by this test, per e2e isolation rules).
interface ListedAutomation {
  id: string;
  name: string;
  active: boolean;
  system_key: string | null;
  board_triggers: { type: string; column_key: string }[];
}
interface Trigger {
  id: string;
  type: string;
  column_key: string | null;
}

test.describe("built-in reviewer", () => {
  test("is on In Review, switches with the review flag, and fires through the workflow", async ({
    authedPage,
  }) => {
    test.setTimeout(90_000);
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    // Seeded right after the org is created, off the signup request.
    const reviewer = async () =>
      (
        await call<{ automations: ListedAutomation[] }>("AUTOMATION_LIST", {})
      ).automations.find((a) => a.system_key === "reviewer");
    await expect.poll(reviewer).toBeDefined();
    expect(await reviewer()).toMatchObject({
      name: "Reviewer",
      active: true,
      board_triggers: [{ type: "board_pr_ready", column_key: "in_review" }],
    });
    const { id } = (await reviewer())!;
    const { automation } = await call<{
      automation: { triggers: Trigger[] };
    }>("AUTOMATION_GET", { id });
    expect(automation.triggers).toEqual([
      expect.objectContaining({
        type: "board_pr_ready",
        column_key: "in_review",
      }),
    ]);

    // Its starter is the Reviewer's alone for now.
    const { id: mine } = await call<{ id: string }>("AUTOMATION_CREATE", {
      name: "Mine",
      virtual_mcp_id: `decopilot_${await findOrgId(request, orgSlug)}`,
      messages: [{ role: "user", parts: [{ type: "text", text: "Hi." }] }],
    });
    await expect(
      call("AUTOMATION_TRIGGER_ADD", {
        automation_id: mine,
        type: "board_pr_ready",
      }),
    ).rejects.toThrow(/built-in Reviewer/);

    // Its switch is the review flag: turning it off reads back off.
    await call("AUTOMATION_UPDATE", { id, active: false });
    expect((await reviewer())?.active).toBe(false);

    // A review asked for by hand still runs, through the fire workflow.
    const { item } = await call<{ item: { id: string } }>(
      "TASK_BOARD_ITEM_CREATE",
      {
        title: "Ship the widget",
        status: "in_review",
        prUrl: "https://github.com/acme-e2e/widget/pull/4242",
      },
    );
    const { queued } = await call<{ queued: boolean }>(
      "TASK_BOARD_RUN_REVIEWER",
      { id: item.id },
    );
    expect(queued).toBe(true);
    const db: Client = await connectDevDb();
    try {
      await expect
        .poll(
          async () =>
            (
              await db.query<{ name: string; status: string }>(
                "select name, status from dbos.workflow_status where workflow_uuid like $1",
                [`auto:${id}:review:${item.id}:%`],
              )
            ).rows,
          { timeout: 30_000 },
        )
        .toEqual([{ name: "fireAutomationWorkflow", status: "SUCCESS" }]);
    } finally {
      await db.end();
    }

    await call("AUTOMATION_UPDATE", { id, active: true });
    expect((await reviewer())?.active).toBe(true);
  });
});
