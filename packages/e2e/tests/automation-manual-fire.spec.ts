/**
 * A run someone asks for on a card (delegating it to the Super Agent, Re-run)
 * is a manual fire of the built-in Implementer: it goes through the automation
 * fire workflow, runs even with the Implementer turned off, and its refusal
 * reaches the caller.
 *
 * The run itself needs a sandbox this tier does not have; that refusal is the
 * one asserted.
 */

import type { Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

// Black-box wire-contract shapes (owned by this test, per e2e isolation rules).
interface ListedAutomation {
  id: string;
  active: boolean;
  system_key: string | null;
}

test.describe("manual fires of the Implementer", () => {
  test("delegating and re-running a card fire the Implementer, even when it is off", async ({
    authedPage,
  }) => {
    test.setTimeout(90_000);
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    // Seeded right after the org is created, off the signup request.
    const implementer = async () =>
      (
        await call<{ automations: ListedAutomation[] }>("AUTOMATION_LIST", {})
      ).automations.find((a) => a.system_key === "implementer");
    await expect.poll(implementer).toBeDefined();
    const { id } = (await implementer())!;
    await call("AUTOMATION_UPDATE", { id, active: false });

    const { item } = await call<{ item: { id: string } }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Hand this to the agent" },
    );
    // Run on a card: delegating it to the Super Agent.
    await call("TASK_BOARD_ITEM_UPDATE", {
      id: item.id,
      assigneeId: "super-agent",
    });

    const db: Client = await connectDevDb();
    try {
      const firesOf = async () =>
        (
          await db.query<{ name: string; status: string }>(
            "select name, status from dbos.workflow_status where workflow_uuid like $1",
            [`auto:${id}:manual:%`],
          )
        ).rows;
      await expect
        .poll(firesOf, { timeout: 20_000 })
        .toEqual([{ name: "fireAutomationWorkflow", status: "SUCCESS" }]);

      // Re-run waits for its fire, so the run's refusal reaches the caller.
      await expect(
        call("TASK_BOARD_ITEM_RERUN", { id: item.id }),
      ).rejects.toThrow(/hosted sandbox/);
      await expect.poll(async () => (await firesOf()).length).toBe(2);
    } finally {
      await db.end();
    }
  });
});
