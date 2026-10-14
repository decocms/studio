/**
 * Real-Postgres coverage for the `board_column_transition` trigger: which
 * moves fire it, that each fires once across the settle wait and the sweep,
 * and which lane moves start a settle wait at all.
 *
 * The run itself is the board's (`enqueueSuperAgentForTask`), which needs a
 * model and a sandbox this tier does not have, so a fire here is visible by
 * what happens before the dispatch: the fire is claimed, and an unassigned
 * card is claimed for the agent (an `assignee_changed` entry) and handed back
 * when the dispatch is refused.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { sql } from "kysely";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import type { StudioContext } from "../core/studio-context";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import { createAutomationsStorage } from "../storage/automations";
import {
  type BoardMove,
  setBoardMoveListener,
  TaskBoardStorage,
} from "../storage/task-board";
import type { TaskBoardItemStatus } from "../storage/types";
import {
  type BoardTransitionDeps,
  settleBoardMove,
  sweepSettledMoves,
} from "./board-column-transition-fire";
import { ensureBuiltinAutomations } from "./builtin";
import {
  type FireAutomationContext,
  runOnCardStep,
  setAutomationRuntime,
} from "./dbos-workflow";

const ORG = "org_test";
const USER = "user_test";
const SETTLE_MS = 20_000;

describe("board column transition trigger (real Postgres)", () => {
  let database: StudioDatabase;
  let taskBoard: TaskBoardStorage;
  let automations: ReturnType<typeof createAutomationsStorage>;
  let deps: BoardTransitionDeps;
  let orgCtx: StudioContext;
  /** The contexts the fire workflow's card step runs with. */
  const runAs = (contexts: {
    member: StudioContext | null;
    org: StudioContext | null;
  }) =>
    setAutomationRuntime({
      storage: automations,
      studioContextFactory: async () => contexts.member,
      orgContextFactory: async () => contexts.org,
    });
  let handed: {
    fire: FireAutomationContext;
    idempotencyKey: string;
  }[];
  /** The sweep's clock: every move below is placed relative to it. */
  const NOW = Date.now();

  beforeAll(async () => {
    database = await connectTestPgDatabase();
  });

  beforeEach(async () => {
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    taskBoard = new TaskBoardStorage(database.db);
    automations = createAutomationsStorage(database.db);
    const ctx = {
      organization: { id: ORG, slug: "org-test", name: ORG },
      auth: { user: { id: USER } },
      storage: { taskBoard, automations },
    } as unknown as StudioContext;
    handed = [];
    // The fire workflow's own card step, minus the queue.
    deps = {
      automations,
      taskBoard,
      fire: async (fire, opts) => {
        handed.push({ fire, ...opts });
        const automation = await automations.findById(
          fire.automationId,
          fire.organizationId,
        );
        if (automation && fire.triggerId && fire.target) {
          await runOnCardStep(automation, fire.triggerId, fire.target);
        }
      },
    };
    orgCtx = ctx;
    runAs({ member: ctx, org: ctx });
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  async function triggerOn(
    columnKey: TaskBoardItemStatus,
    opts: { fromKind?: "any" | "earlier" | "later"; createdAt?: Date } = {},
  ) {
    const automation = await automations.create({
      organization_id: ORG,
      name: "Triage",
      created_by: USER,
      messages: JSON.stringify([
        { role: "user", parts: [{ type: "text", text: "Triage it." }] },
      ]),
      models: JSON.stringify({ tier: "smart" }),
      virtual_mcp_id: "decopilot_org_test",
    });
    const trigger = await automations.addTrigger({
      automation_id: automation.id,
      type: "board_column_transition",
      column_key: columnKey,
      from_kind: opts.fromKind ?? "any",
    });
    const createdAt = opts.createdAt ?? new Date(NOW - 60 * 60_000);
    await sql`
      update automation_triggers set created_at = ${createdAt.toISOString()}
       where id = ${trigger.id}
    `.execute(database.db);
    return trigger;
  }

  /** A card whose lane history is `moves`, each `secondsAgo` before NOW. */
  async function card(
    moves: { from: string | null; to: string; secondsAgo: number }[],
    opts: { assigneeId?: string } = {},
  ) {
    const item = await taskBoard.create({
      organizationId: ORG,
      title: "a card",
      by: USER,
      ...(opts.assigneeId ? { assigneeId: opts.assigneeId } : {}),
    });
    for (const [i, move] of moves.entries()) {
      await database.db
        .insertInto("task_board_activity")
        .values({
          id: `act_${item.id}_${i}`,
          task_board_item_id: item.id,
          action: "status_changed" as const,
          actor_id: USER,
          data: JSON.stringify({ from: move.from, to: move.to }),
          occurred_at: new Date(NOW - move.secondsAgo * 1000).toISOString(),
        })
        .execute();
    }
    const last = moves.at(-1);
    if (last) {
      await sql`update task_board_items set status = ${last.to} where id = ${item.id}`.execute(
        database.db,
      );
    }
    return item;
  }

  const fires = async () =>
    (
      await sql<{
        n: number;
      }>`select count(*)::int as n from automation_trigger_fires`.execute(
        database.db,
      )
    ).rows[0]?.n;

  const claimedForAgent = async (itemId: string) =>
    (await taskBoard.listActivity(itemId, ORG)).some(
      (a) => a.action === "assignee_changed",
    );

  const activityIds = async (itemId: string) =>
    (await taskBoard.listActivity(itemId, ORG))
      .filter((a) => a.action === "status_changed")
      .map((a) => a.id);

  it("fires a settled move once, however many sweeps see it", async () => {
    await triggerOn("in_progress");
    const moved = await card([
      { from: "triage", to: "in_progress", secondsAgo: 30 },
    ]);

    await sweepSettledMoves(deps, NOW, SETTLE_MS);
    await sweepSettledMoves(deps, NOW, SETTLE_MS);

    expect(await fires()).toBe(1);
    // Claimed for the agent, then handed back when the dispatch was refused.
    expect(await claimedForAgent(moved.id)).toBe(true);
    expect((await taskBoard.getById(moved.id, ORG))?.assigneeId).toBeNull();
  });

  it("waits until the card has rested in the column", async () => {
    await triggerOn("in_progress");
    await card([{ from: "triage", to: "in_progress", secondsAgo: 5 }]);

    await sweepSettledMoves(deps, NOW, SETTLE_MS);

    expect(await fires()).toBe(0);
  });

  it("ignores a column the card was only dragged through", async () => {
    await triggerOn("qa");
    await card([
      { from: "in_review", to: "qa", secondsAgo: 40 },
      { from: "qa", to: "customer_approval", secondsAgo: 35 },
    ]);

    await sweepSettledMoves(deps, NOW, SETTLE_MS);

    expect(await fires()).toBe(0);
  });

  it("leaves a card a person owns alone", async () => {
    await triggerOn("in_progress");
    const owned = await card(
      [{ from: "triage", to: "in_progress", secondsAgo: 30 }],
      { assigneeId: USER },
    );

    await sweepSettledMoves(deps, NOW, SETTLE_MS);

    // The fire is spent on the move; the card keeps its owner.
    expect(await fires()).toBe(1);
    expect((await taskBoard.getById(owned.id, ORG))?.assigneeId).toBe(USER);
    expect(await claimedForAgent(owned.id)).toBe(false);
  });

  it("answers only the moves its origin rule names", async () => {
    await triggerOn("qa", { fromKind: "earlier" });
    await card([{ from: "customer_approval", to: "qa", secondsAgo: 30 }]);

    await sweepSettledMoves(deps, NOW, SETTLE_MS);

    expect(await fires()).toBe(0);
  });

  it("does not answer a move made before the trigger existed", async () => {
    await triggerOn("in_progress", { createdAt: new Date(NOW - 10_000) });
    await card([{ from: "triage", to: "in_progress", secondsAgo: 30 }]);

    await sweepSettledMoves(deps, NOW, SETTLE_MS);

    expect(await fires()).toBe(0);
  });

  it("does nothing for an inactive automation", async () => {
    const trigger = await triggerOn("in_progress");
    await sql`update automations set active = false where id = ${trigger.automation_id}`.execute(
      database.db,
    );
    await card([{ from: "triage", to: "in_progress", secondsAgo: 30 }]);

    await sweepSettledMoves(deps, NOW, SETTLE_MS);

    expect(await fires()).toBe(0);
  });

  it("fires one move when its settle wait ends, once with the sweep", async () => {
    await triggerOn("in_progress");
    const moved = await card([
      { from: "triage", to: "in_progress", secondsAgo: 30 },
    ]);
    const [move] = await activityIds(moved.id);

    await settleBoardMove(deps, move!, NOW, SETTLE_MS);
    await sweepSettledMoves(deps, NOW, SETTLE_MS);

    expect(await fires()).toBe(1);
    expect(await claimedForAgent(moved.id)).toBe(true);
  });

  it("does not fire a move the card has since left", async () => {
    await triggerOn("in_progress");
    const moved = await card([
      { from: "triage", to: "in_progress", secondsAgo: 60 },
      { from: "in_progress", to: "in_review", secondsAgo: 30 },
    ]);
    const [first] = await activityIds(moved.id);

    await settleBoardMove(deps, first!, NOW, SETTLE_MS);

    expect(await fires()).toBe(0);
  });

  it("starts a settle wait only for a column an active trigger watches", async () => {
    const trigger = await triggerOn("qa");
    const item = await card([]);
    const watched = () =>
      automations.hasActiveBoardColumnTrigger(item.id, "qa");

    expect(await watched()).toBe(true);
    expect(
      await automations.hasActiveBoardColumnTrigger(item.id, "in_review"),
    ).toBe(false);
    await sql`update automations set active = false where id = ${trigger.automation_id}`.execute(
      database.db,
    );
    expect(await watched()).toBe(false);
  });

  it("announces each logged lane move, and nothing else", async () => {
    const heard: BoardMove[] = [];
    setBoardMoveListener(async (move) => {
      heard.push(move);
    });
    try {
      const item = await card([]);
      await taskBoard.recordActivity({
        taskBoardItemId: item.id,
        action: "status_changed",
        actorId: USER,
        data: { from: "triage", to: "in_progress" },
      });
      await taskBoard.recordActivities([
        {
          taskBoardItemId: item.id,
          action: "status_changed",
          actorId: null,
          data: { from: "in_progress", to: "in_progress" },
        },
        {
          taskBoardItemId: item.id,
          action: "assignee_changed",
          actorId: USER,
          data: { from: null, to: USER },
        },
        {
          taskBoardItemId: item.id,
          action: "status_changed",
          actorId: USER,
          data: { from: "in_progress", to: "in_review" },
        },
      ]);

      expect(heard.map((m) => m.to)).toEqual(["in_progress", "in_review"]);
      const logged = await taskBoard.listActivity(item.id, ORG);
      for (const move of heard) {
        expect(move.taskBoardItemId).toBe(item.id);
        expect(logged.find((a) => a.id === move.activityId)?.data).toEqual({
          from: expect.any(String),
          to: move.to,
        });
      }
    } finally {
      setBoardMoveListener(null);
    }
  });

  it("hands a fire to the automation workflow with the card as its target", async () => {
    const trigger = await triggerOn("in_progress");
    const moved = await card([
      { from: "triage", to: "in_progress", secondsAgo: 30 },
    ]);
    const [move] = await activityIds(moved.id);

    await sweepSettledMoves(deps, NOW, SETTLE_MS);

    expect(handed).toEqual([
      {
        fire: {
          automationId: trigger.automation_id,
          organizationId: ORG,
          triggerId: trigger.id,
          target: {
            kind: "card",
            itemId: moved.id,
            columnKey: "in_progress",
            eventKey: move!,
          },
        },
        // One workflow per (trigger, move), however many times it is handed over.
        idempotencyKey: `board:${trigger.id}:${move}`,
      },
    ]);
  });

  it("runs the implementer as the org, and leaves a delegated card to its run", async () => {
    await ensureBuiltinAutomations(database.db, { id: ORG, createdBy: USER });
    await sql`update automation_triggers set created_at = ${new Date(NOW - 60 * 60_000).toISOString()}`.execute(
      database.db,
    );
    const unassigned = await card([
      { from: "triage", to: "in_progress", secondsAgo: 30 },
    ]);
    const delegated = await card(
      [{ from: "triage", to: "in_progress", secondsAgo: 30 }],
      { assigneeId: SUPER_AGENT_ASSIGNEE_ID },
    );
    // A built-in belongs to the org: no member context is asked for.
    runAs({ member: null, org: orgCtx });

    await sweepSettledMoves(deps, NOW, SETTLE_MS);

    expect(await claimedForAgent(unassigned.id)).toBe(true);
    expect(await claimedForAgent(delegated.id)).toBe(false);
    expect((await taskBoard.getById(delegated.id, ORG))?.assigneeId).toBe(
      SUPER_AGENT_ASSIGNEE_ID,
    );
  });
});
