/**
 * The `board_column_transition` trigger over the wire: an automation gets
 * one, reads it back with its column, and a trigger without a column is
 * refused; the starter dialog adds one with its origin; a card that settles
 * in the column is fired on once, and a move into a column nothing watches
 * starts no settle wait. Every org also has the built-in implementer, which
 * the tools only let it turn on or off, and a column's rules sheet turns the
 * automations on that column on and off.
 *
 * The run itself needs a model and a sandbox this tier does not have, so the
 * fire is asserted by its claim and by the fire workflow that ran it. Which moves fire is covered at the
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
const SETTLED_MS = 20_000;

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

      // The fire runs through the automation fire workflow, like any other
      // trigger's, which then runs it on the card.
      const fireOf = async () =>
        (
          await db.query<{ name: string; status: string }>(
            "select name, status from dbos.workflow_status where workflow_uuid = $1",
            [`auto:${id}:board:${trigger.id}:${watchedMove}`],
          )
        ).rows;
      await expect
        .poll(fireOf, { timeout: SETTLED_MS })
        .toEqual([{ name: "fireAutomationWorkflow", status: "SUCCESS" }]);
    } finally {
      await db.end();
    }
  });

  test("the starter dialog adds a trigger with its origin", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const orgId = await findOrgId(request, orgSlug);
    const agentId = `decopilot_${orgId}`;
    const { id } = await callSelfMcpTool<{ id: string }>(
      request,
      orgSlug,
      "AUTOMATION_CREATE",
      {
        name: "Fix what came back",
        virtual_mcp_id: agentId,
        messages: [
          { role: "user", parts: [{ type: "text", text: "Fix it." }] },
        ],
      },
    );

    await page.goto(`/${orgSlug}/projects/${agentId}/automations/${id}`);
    await page.getByRole("button", { name: /Add starter/i }).click();
    await page
      .getByRole("menuitem", { name: /When a card enters a column/i })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "QA", exact: true }).click();
    await dialog.getByRole("combobox").nth(1).click();
    await page.getByRole("option", { name: "Specific columns" }).click();
    const add = dialog.getByRole("button", { name: "Add starter" });
    // A list with nothing in it would match no move.
    await expect(add).toBeDisabled();
    await dialog.getByRole("button", { name: /Pick columns/ }).click();
    await page.getByRole("option", { name: "Customer Approval" }).click();
    await page.keyboard.press("Escape");
    await add.click();

    await expect(page.getByText("When a card enters QA")).toBeVisible();
    await expect(page.getByText("From Customer Approval")).toBeVisible();
    const { automation } = await callSelfMcpTool<{
      automation: { triggers: Trigger[] };
    }>(request, orgSlug, "AUTOMATION_GET", { id });
    expect(automation.triggers).toEqual([
      expect.objectContaining({
        type: "board_column_transition",
        column_key: "qa",
        from: { kind: "statuses", statuses: ["customer_approval"] },
      }),
    ]);
  });

  test("every org has the built-in implementer, which can only be turned on or off", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);
    const orgId = await findOrgId(request, orgSlug);

    // Seeded right after the org is created, off the signup request.
    const builtin = async () =>
      (
        await call<{
          automations: {
            id: string;
            name: string;
            active: boolean;
            system_key: string | null;
            virtual_mcp_id: string;
          }[];
        }>("AUTOMATION_LIST", {})
      ).automations.find((a) => a.system_key === "implementer");
    await expect.poll(builtin).toBeDefined();
    const implementer = (await builtin())!;
    expect(implementer).toMatchObject({
      name: "Implementer",
      active: true,
      virtual_mcp_id: `decopilot_${orgId}`,
    });
    const { automation } = await call<{
      automation: { triggers: Trigger[] };
    }>("AUTOMATION_GET", { id: implementer.id });
    expect(automation.triggers).toEqual([
      expect.objectContaining({
        type: "board_column_transition",
        column_key: "in_progress",
        from: { kind: "any" },
      }),
    ]);

    await expect(
      call("AUTOMATION_DELETE", { id: implementer.id }),
    ).rejects.toThrow(/can't be deleted/);
    await expect(
      call("AUTOMATION_UPDATE", { id: implementer.id, name: "Mine now" }),
    ).rejects.toThrow(/only be turned on or off/);
    await expect(
      call("AUTOMATION_TRIGGER_ADD", {
        automation_id: implementer.id,
        type: "board_column_transition",
        column_key: "qa",
      }),
    ).rejects.toThrow(/starters can't be changed/);
    await expect(
      call("AUTOMATION_TRIGGER_REMOVE", {
        trigger_id: automation.triggers[0]!.id,
      }),
    ).rejects.toThrow(/starters can't be changed/);

    // It answers an unassigned card that settles in In Progress.
    test.setTimeout(60_000);
    const { item } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Nobody picked this up" },
    );
    await call("TASK_BOARD_ITEM_UPDATE", {
      id: item.id,
      status: "in_progress",
    });
    const db: Client = await connectDevDb();
    try {
      await expect
        .poll(
          async () =>
            (
              await db.query(
                "select 1 from automation_trigger_fires where trigger_id = $1",
                [automation.triggers[0]!.id],
              )
            ).rowCount,
          { timeout: SETTLED_MS },
        )
        .toBe(1);

      // Through the same fire workflow as any automation, not a path of its own.
      const { activity } = await call<{ activity: Activity[] }>(
        "TASK_BOARD_ACTIVITY_LIST",
        { taskBoardItemId: item.id },
      );
      const move = activity.find(
        (a) => a.action === "status_changed" && a.data.to === "in_progress",
      );
      expect(move).toBeDefined();
      const fireOf = async () =>
        (
          await db.query<{ name: string; status: string }>(
            "select name, status from dbos.workflow_status where workflow_uuid = $1",
            [
              `auto:${implementer.id}:board:${automation.triggers[0]!.id}:${move!.id}`,
            ],
          )
        ).rows;
      await expect
        .poll(fireOf, { timeout: SETTLED_MS })
        .toEqual([{ name: "fireAutomationWorkflow", status: "SUCCESS" }]);
    } finally {
      await db.end();
    }

    await call("AUTOMATION_UPDATE", { id: implementer.id, active: false });
    expect((await builtin())?.active).toBe(false);
  });

  test("a column's sheet lists the automations that run there and opens them", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);
    const implementer = async () =>
      (
        await call<{
          automations: {
            id: string;
            active: boolean;
            system_key: string | null;
          }[];
        }>("AUTOMATION_LIST", {})
      ).automations.find((a) => a.system_key === "implementer");
    await expect.poll(implementer).toBeDefined();
    const builtin = (await implementer())!;
    // The board draws its lanes once it has a card.
    await call("TASK_BOARD_ITEM_CREATE", { title: "Something to do" });

    await page.goto(`/${orgSlug}/tasks`);
    // The sheet opens from the column's "…" menu.
    const menu = page.getByRole("button", {
      name: "More actions for In Progress",
    });
    await menu.waitFor({ state: "attached", timeout: 30_000 });
    await menu.click({ force: true });
    await page.getByRole("menuitem", { name: "How this column works" }).click();

    const sheet = page.getByRole("dialog", { name: "In Progress" });
    await expect(
      sheet.getByText(
        "The agent implements the task and opens a pull request for review.",
      ),
    ).toBeVisible();
    // Read-only: the automation is edited on its own page, one click away.
    const row = sheet.getByRole("link", { name: /Implementer/ });
    await expect(row).toContainText(
      builtin.active ? "Runs when a card enters" : "Off",
    );
    await expect(sheet.getByRole("switch")).toHaveCount(0);
    await row.click();
    await expect(page).toHaveURL((url) =>
      url.pathname.endsWith(`/automations/${builtin.id}`),
    );
  });
});
