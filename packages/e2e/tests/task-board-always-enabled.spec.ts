import type { Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

interface TaskBoardItem {
  id: string;
  title: string;
  status: string;
}

test.describe("always-available task board", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();
  });

  test.afterAll(async () => {
    await db?.end();
  });

  test("all task-board tools work without an organization-settings row", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const orgResult = await db.query<{ id: string }>(
      `SELECT id FROM "organization" WHERE slug = $1`,
      [orgSlug],
    );
    const organizationId = orgResult.rows[0]?.id;
    if (!organizationId) throw new Error("organization not found after signup");

    await db.query(
      `DELETE FROM "organization_settings" WHERE "organizationId" = $1`,
      [organizationId],
    );

    const created = await callSelfMcpTool<{ item: TaskBoardItem }>(
      request,
      orgSlug,
      "TASK_BOARD_ITEM_CREATE",
      { title: "Always available" },
    );
    expect(created.item.title).toBe("Always available");

    const listed = await callSelfMcpTool<{ items: TaskBoardItem[] }>(
      request,
      orgSlug,
      "TASK_BOARD_ITEM_LIST",
      {},
    );
    expect(listed.items.map((item) => item.id)).toContain(created.item.id);

    const updated = await callSelfMcpTool<{ item: TaskBoardItem }>(
      request,
      orgSlug,
      "TASK_BOARD_ITEM_UPDATE",
      { id: created.item.id, status: "todo" },
    );
    expect(updated.item.status).toBe("todo");

    const prs = await callSelfMcpTool<{ prs: unknown[] }>(
      request,
      orgSlug,
      "TASK_BOARD_ITEM_PRS_GET",
      { taskBoardItemId: created.item.id },
    );
    expect(prs.prs).toEqual([]);

    await expect(
      callSelfMcpTool<{ success: boolean }>(
        request,
        orgSlug,
        "TASK_BOARD_ITEM_DELETE",
        { id: created.item.id },
      ),
    ).resolves.toEqual({ success: true });

    const settings = await db.query(
      `SELECT 1 FROM "organization_settings" WHERE "organizationId" = $1`,
      [organizationId],
    );
    expect(settings.rowCount).toBe(0);
  });
});
