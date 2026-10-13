/**
 * The `board_column_transition` trigger over the wire: an automation gets
 * one, reads it back with its column, and a trigger without a column is
 * refused; a card that settles in the column is fired on once, and a move
 * into a column nothing watches starts no settle wait.
 *
 * The run itself needs a model and a sandbox this tier does not have, so the
 * fire is asserted by its claim. Which moves fire is covered at the
 * integration tier (`board-column-transition-fire.integration.test.ts`).
 */

import type { Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool, findOrgId } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

// Black-box wire-contract shapes (owned by this test, per e2e isolation rules).
interface Trigger {
  id: string;
  type: string;
  column_key: string | null;
  from: { kind: string; statuses?: string[] } | null;
}
interface TaskBoardItem {
  id: string;
}
interface Activity {
  id: string;
  action: string;
  data: Record<string, unknown>;
}

/** Longer than the server's `BOARD_TRANSITION_SETTLE_SECONDS` plus its
 *  clock-skew margin, with room for the queue to pick the wait up. */
const SETTLED_MS = 15_000;

test.describe("automation board column trigger", () => {
  test("an automation runs on cards entering a column", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);
    const orgId = await findOrgId(request, orgSlug);

    const { id } = await call<{ id: string }>("AUTOMATION_CREATE", {
      name: "Triage new work",
      virtual_mcp_id: `decopilot_${orgId}`,
      messages: [
        { role: "user", parts: [{ type: "text", text: "Triage the card." }] },
      ],
    });

    const added = await call<Trigger>("AUTOMATION_TRIGGER_ADD", {
      automation_id: id,
      type: "board_column_transition",
      column_key: "qa",
      from: { kind: "statuses", statuses: ["in_review"] },
    });
    expect(added.type).toBe("board_column_transition");

    const { automation } = await call<{
      automation: { triggers: Trigger[] };
    }>("AUTOMATION_GET", { id });
    expect(automation.triggers).toEqual([
      expect.objectContaining({
        id: added.id,
        type: "board_column_transition",
        column_key: "qa",
        from: { kind: "statuses", statuses: ["in_review"] },
      }),
    ]);

    await expect(
      call("AUTOMATION_TRIGGER_ADD", {
        automation_id: id,
        type: "board_column_transition",
      }),
    ).rejects.toThrow(/column_key is required/);
    await expect(
      call("AUTOMATION_TRIGGER_ADD", {
        automation_id: id,
        type: "board_column_transition",
        column_key: "not_a_column",
      }),
    ).rejects.toThrow();
  });

  test("a card that settles in the column is fired on once", async ({
    authedPage,
  }) => {
    test.setTimeout(60_000);
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);
    const orgId = await findOrgId(request, orgSlug);
    const db: Client = await connectDevDb();
    try {
      const { id } = await call<{ id: string }>("AUTOMATION_CREATE", {
        name: "Check it",
        virtual_mcp_id: `decopilot_${orgId}`,
        messages: [
          { role: "user", parts: [{ type: "text", text: "Check the card." }] },
        ],
      });
      const trigger = await call<Trigger>("AUTOMATION_TRIGGER_ADD", {
        automation_id: id,
        type: "board_column_transition",
        column_key: "qa",
      });
      // Strictly after the trigger: it answers the moves made once it exists.
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      const { item: watched } = await call<{ item: TaskBoardItem }>(
        "TASK_BOARD_ITEM_CREATE",
        { title: "Lands in QA" },
      );
      await call("TASK_BOARD_ITEM_UPDATE", { id: watched.id, status: "qa" });
      const { item: unwatched } = await call<{ item: TaskBoardItem }>(
        "TASK_BOARD_ITEM_CREATE",
        { title: "Lands in Customer Approval" },
      );
      await call("TASK_BOARD_ITEM_UPDATE", {
        id: unwatched.id,
        status: "customer_approval",
      });

      const moveInto = async (itemId: string, to: string) => {
        const { activity } = await call<{ activity: Activity[] }>(
          "TASK_BOARD_ACTIVITY_LIST",
          { taskBoardItemId: itemId },
        );
        const move = activity.find(
          (a) => a.action === "status_changed" && a.data.to === to,
        );
        expect(move).toBeDefined();
        return move!.id;
      };
      const watchedMove = await moveInto(watched.id, "qa");
      const unwatchedMove = await moveInto(unwatched.id, "customer_approval");

      const firesOf = async () =>
        (
          await db.query<{ event_key: string }>(
            "select event_key from automation_trigger_fires where trigger_id = $1",
            [trigger.id],
          )
        ).rows.map((r) => r.event_key);
      await expect
        .poll(firesOf, { timeout: SETTLED_MS })
        .toEqual([watchedMove]);

      const waits = await db.query<{ workflow_uuid: string }>(
        "select workflow_uuid from dbos.workflow_status where workflow_uuid = any($1)",
        [[`board-settle:${watchedMove}`, `board-settle:${unwatchedMove}`]],
      );
      expect(waits.rows.map((r) => r.workflow_uuid)).toEqual([
        `board-settle:${watchedMove}`,
      ]);
    } finally {
      await db.end();
    }
  });
});
