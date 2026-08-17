/**
 * A task's cost, as the board reads it.
 *
 * The rollup is a jsonb SUM inside the board's own list query, so it needs real
 * Postgres: numeric arrives as a string, SUM over no rows is NULL, and neither
 * survives an in-memory fake. What it protects is the distinction between "this
 * run recorded no usage" (null, render nothing) and "this run was free" (0) —
 * getting that wrong shows every un-instrumented card a $0.00 nobody measured.
 */
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

// Black-box wire-contract shapes (owned by this test, per e2e isolation rules).
interface TaskBoardItemThread {
  threadId: string;
  costUsd: number | null;
}
interface TaskBoardItem {
  id: string;
  threads: TaskBoardItemThread[];
}

/** A finished assistant message carrying the usage a harness recorded. */
function usageMetadata(costUsd: number | null): string {
  return JSON.stringify({
    usage: {
      totalTokens: 100,
      ...(costUsd === null
        ? {}
        : { providerMetadata: { openrouter: { usage: { cost: costUsd } } } }),
    },
  });
}

test.describe("task cost rollup", () => {
  test("sums every linked run, and distinguishes unmeasured from free", async ({
    authedPage,
  }) => {
    const { page, orgSlug, user } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const { item } = await call<{ item: { id: string } }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Cost rollup task" },
    );

    const db = await connectDevDb();
    try {
      const { rows: orgRows } = await db.query<{ organization_id: string }>(
        `SELECT organization_id FROM task_board_items WHERE id = $1`,
        [item.id],
      );
      const orgId = orgRows[0]?.organization_id;
      expect(orgId).toBeTruthy();

      // Three runs on one card: two priced, one that recorded nothing.
      const runs: Array<[string, number | null]> = [
        [`thrd_e2e_cost_a_${item.id}`, 1.25],
        [`thrd_e2e_cost_b_${item.id}`, 0.75],
        [`thrd_e2e_cost_c_${item.id}`, null],
      ];
      for (const [threadId, cost] of runs) {
        await db.query(
          `INSERT INTO threads (id, organization_id, title, status, message_storage_version, created_by)
           VALUES ($1, $2, $3, 'completed', 2, $4)`,
          [threadId, orgId, `Run ${threadId}`, user.userId],
        );
        await db.query(
          `INSERT INTO task_board_item_threads (task_board_item_id, thread_id, organization_id)
           VALUES ($1, $2, $3)`,
          [item.id, threadId, orgId],
        );
        await db.query(
          `INSERT INTO thread_message_parts
             (id, seq, org_id, thread_id, run_id, message_id, role, kind, payload, metadata, created_at)
           VALUES ($1, 1, $2, $3, $3, $4, 'assistant', 'finish', '{}'::jsonb, $5::jsonb, $6)`,
          [
            `part_${threadId}`,
            orgId,
            threadId,
            `msg_${threadId}`,
            usageMetadata(cost),
            new Date().toISOString(),
          ],
        );
      }

      const { items } = await call<{ items: TaskBoardItem[] }>(
        "TASK_BOARD_ITEM_LIST",
        {},
      );
      const card = items.find((i) => i.id === item.id);
      expect(card).toBeTruthy();

      const byThread = new Map(
        (card?.threads ?? []).map((t) => [t.threadId, t.costUsd]),
      );
      expect(byThread.get(`thrd_e2e_cost_a_${item.id}`)).toBeCloseTo(1.25, 6);
      expect(byThread.get(`thrd_e2e_cost_b_${item.id}`)).toBeCloseTo(0.75, 6);
      // Recorded no cost, so it sums to 0 rather than reporting a price.
      expect(byThread.get(`thrd_e2e_cost_c_${item.id}`)).toBe(0);

      const total = (card?.threads ?? []).reduce(
        (sum, t) => sum + (t.costUsd ?? 0),
        0,
      );
      expect(total).toBeCloseTo(2.0, 6);
    } finally {
      await db.end();
    }
  });

  test("a card with no runs reports no cost at all", async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const { item } = await call<{ item: { id: string } }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Never dispatched" },
    );
    const { items } = await call<{ items: TaskBoardItem[] }>(
      "TASK_BOARD_ITEM_LIST",
      {},
    );
    expect(items.find((i) => i.id === item.id)?.threads).toEqual([]);
  });
});
