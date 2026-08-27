/**
 * A task's linked agent run opens inline, not by navigating away.
 *
 * Clicking a run on a task used to leave the task for that run's chat. It now
 * opens a read-only sheet over the task, so the two assertions that matter are
 * that the transcript is really there and that `?task=` never moved — the task
 * is still the page you are on.
 *
 * The transcript is rendered by the live chat's own message components, which
 * reach for the ambient chat context to decorate a message. On the board that
 * context belongs to a *different* thread, so one test pins that the sheet is
 * detached from it. That one fails loudly if `DetachedChatContext` is dropped.
 */
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";
import type { Page } from "@playwright/test";

const detail = (page: Page) => page.getByTestId("task-detail");
const sheet = (page: Page) => page.getByTestId("task-thread-sheet");

/** Seeds a linked run with a two-turn transcript, and returns its thread id. */
async function seedRun(
  db: Awaited<ReturnType<typeof connectDevDb>>,
  opts: {
    itemId: string;
    orgId: string;
    userId: string;
    suffix: string;
    title: string;
    /** Older runs sort below newer ones in the sheet's prev/next order. */
    createdAt: Date;
    assistantText: string;
  },
): Promise<string> {
  const threadId = `thrd_e2e_drawer_${opts.suffix}_${opts.itemId}`;
  await db.query(
    `INSERT INTO threads (id, organization_id, title, status, message_storage_version, created_by, created_at)
     VALUES ($1, $2, $3, 'completed', 2, $4, $5)`,
    [
      threadId,
      opts.orgId,
      opts.title,
      opts.userId,
      opts.createdAt.toISOString(),
    ],
  );
  await db.query(
    `INSERT INTO task_board_item_threads (task_board_item_id, thread_id, organization_id, created_at)
     VALUES ($1, $2, $3, $4)`,
    [opts.itemId, threadId, opts.orgId, opts.createdAt.toISOString()],
  );
  const turns: Array<["user" | "assistant", string]> = [
    ["user", `Kick off ${opts.suffix}`],
    ["assistant", opts.assistantText],
  ];
  for (let i = 0; i < turns.length; i++) {
    const [role, text] = turns[i]!;
    await db.query(
      `INSERT INTO thread_message_parts
         (id, seq, org_id, thread_id, run_id, message_id, role, kind, payload, metadata, created_at)
       VALUES ($1, $2, $3, $4, $4, $5, $6, 'text', $7::jsonb, NULL, $8)`,
      [
        `part_${threadId}_${i}`,
        i,
        opts.orgId,
        threadId,
        `msg_${threadId}_${i}`,
        role,
        JSON.stringify({ type: "text", text }),
        new Date(opts.createdAt.getTime() + i * 1000).toISOString(),
      ],
    );
  }
  return threadId;
}

async function orgIdOf(
  db: Awaited<ReturnType<typeof connectDevDb>>,
  itemId: string,
): Promise<string> {
  const { rows } = await db.query<{ organization_id: string }>(
    `SELECT organization_id FROM task_board_items WHERE id = $1`,
    [itemId],
  );
  const orgId = rows[0]?.organization_id;
  expect(orgId).toBeTruthy();
  return orgId!;
}

/** Open the board, then the seeded task's detail page. */
async function openTask(page: Page, orgSlug: string, title: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${orgSlug}?main=board`);
  const card = page.locator(`button:has-text("${title}")`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  await expect(detail(page)).toBeVisible();
}

test.describe("task run drawer", () => {
  test("a run opens in a sheet over the task, not by navigating to it", async ({
    authedPage,
  }) => {
    const { page, orgSlug, user } = authedPage;
    const request = page.context().request;
    const title = `Drawer task ${Date.now()}`;
    const { item } = await callSelfMcpTool<{ item: { id: string } }>(
      request,
      orgSlug,
      "TASK_BOARD_ITEM_CREATE",
      { title },
    );

    const db = await connectDevDb();
    try {
      const orgId = await orgIdOf(db, item.id);
      await seedRun(db, {
        itemId: item.id,
        orgId,
        userId: user.userId,
        suffix: "solo",
        title: "Super Agent · drawer run",
        createdAt: new Date(),
        assistantText: "Rounded once at the end instead of per line item.",
      });
    } finally {
      await db.end();
    }

    await openTask(page, orgSlug, title);
    const url = page.url();

    await detail(page)
      .getByRole("button", { name: /Super Agent · drawer run/ })
      .click();

    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page)).toContainText(
      "Rounded once at the end instead of per line item.",
    );
    // The whole point: the task is still the page, still mounted underneath.
    expect(page.url()).toBe(url);
    await expect(page).toHaveURL(/[?&]task=/);
    await expect(detail(page)).toBeVisible();

    // Closing keeps the task open and the app clickable (see detail-menu spec).
    await sheet(page).getByRole("button", { name: "Close" }).click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(page).toHaveURL(/[?&]task=/);
    await expect(detail(page)).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => getComputedStyle(document.body).pointerEvents),
      )
      .toBe("auto");
  });

  test("each run opens its own transcript, with no list navigation", async ({
    authedPage,
  }) => {
    const { page, orgSlug, user } = authedPage;
    const request = page.context().request;
    const title = `Drawer nav task ${Date.now()}`;
    const { item } = await callSelfMcpTool<{ item: { id: string } }>(
      request,
      orgSlug,
      "TASK_BOARD_ITEM_CREATE",
      { title },
    );

    const now = Date.now();
    const db = await connectDevDb();
    try {
      const orgId = await orgIdOf(db, item.id);
      await seedRun(db, {
        itemId: item.id,
        orgId,
        userId: user.userId,
        suffix: "older",
        title: "Super Agent · first pass",
        createdAt: new Date(now - 3_600_000),
        assistantText: "First pass finished, opened a PR.",
      });
      await seedRun(db, {
        itemId: item.id,
        orgId,
        userId: user.userId,
        suffix: "newer",
        title: "QA Agent · second pass",
        createdAt: new Date(now),
        assistantText: "Second pass verified the first one.",
      });
    } finally {
      await db.end();
    }

    await openTask(page, orgSlug, title);
    await detail(page)
      .getByRole("button", { name: /QA Agent · second pass/ })
      .click();
    await expect(sheet(page)).toContainText(
      "Second pass verified the first one.",
    );

    /* Walking the task's other runs is the activity feed's job, so the sheet
       carries neither chevron — only its close control. */
    await expect(
      sheet(page).getByRole("button", { name: /next chat|previous chat/i }),
    ).toHaveCount(0);

    // The feed is how the other run is reached.
    await sheet(page).getByRole("button", { name: "Close" }).click();
    await expect(sheet(page)).toHaveCount(0);
    await detail(page)
      .getByRole("button", { name: /Super Agent · first pass/ })
      .click();
    await expect(sheet(page)).toContainText(
      "First pass finished, opened a PR.",
    );
  });

  test("the sheet reads the run it was opened for, not the chat behind it", async ({
    authedPage,
  }) => {
    const { page, orgSlug, user } = authedPage;
    const request = page.context().request;
    const title = `Drawer isolation task ${Date.now()}`;
    const { item } = await callSelfMcpTool<{ item: { id: string } }>(
      request,
      orgSlug,
      "TASK_BOARD_ITEM_CREATE",
      { title },
    );

    const db = await connectDevDb();
    try {
      const orgId = await orgIdOf(db, item.id);
      await seedRun(db, {
        itemId: item.id,
        orgId,
        userId: user.userId,
        suffix: "isolated",
        title: "Super Agent · isolated run",
        createdAt: new Date(),
        assistantText: "SENTINEL_LINKED_RUN_MESSAGE",
      });
    } finally {
      await db.end();
    }

    await openTask(page, orgSlug, title);
    await detail(page)
      .getByRole("button", { name: /Super Agent · isolated run/ })
      .click();

    await expect(sheet(page)).toContainText("SENTINEL_LINKED_RUN_MESSAGE");
    /* The board renders inside the ambient chat's providers. Undetached, the
       message renderers would decorate this transcript with that thread's
       produced files and a send control that posts into it. */
    await expect(
      sheet(page).getByRole("button", { name: /send|reply/i }),
    ).toHaveCount(0);
  });
});
