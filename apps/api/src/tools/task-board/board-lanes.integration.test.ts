/**
 * Real-Postgres coverage for the board's lanes: the people's checks an agent
 * run cannot pass, an approval landing in QA, and the merge starting only from
 * Ready for Deployment.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import type { StudioContext } from "../../core/studio-context";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../../database/test-db-pg";
import { OrganizationSettingsStorage } from "../../storage/organization-settings";
import { TaskBoardStorage } from "../../storage/task-board";
import { ColumnAutomationStorage } from "../../storage/task-board-column-automations";
import type { TaskBoardItemStatus } from "../../storage/types";
import { TASK_BOARD_PROMOTE_TO_PRODUCTION } from "./promote-to-production";
import { moveApprovedCardToQa } from "./run-reactions";
import { taskRunContextStore } from "./task-run-context";
import { TASK_BOARD_ITEM_UPDATE } from "./update";

const ORG = "org_board_lanes";
const USER = "user_board_lanes";

describe("board lanes (real Postgres)", () => {
  let database: StudioDatabase;
  let taskBoard: TaskBoardStorage;
  let ctx: StudioContext;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    await database.db
      .insertInto("organization")
      .values({ id: ORG, name: ORG, slug: "org-board-lanes", createdAt: now })
      .execute();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"lanes@board.test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    taskBoard = new TaskBoardStorage(database.db);
    ctx = {
      timings: {
        measure: async <T>(_name: string, cb: () => Promise<T>) => await cb(),
      },
      auth: { user: { id: USER, email: "lanes@board.test", name: USER } },
      organization: { id: ORG, slug: "org-board-lanes", name: ORG },
      db: database.db,
      storage: {
        taskBoard,
        organizationSettings: new OrganizationSettingsStorage(database.db),
        columnAutomations: new ColumnAutomationStorage(database.db),
      },
      access: {
        granted: () => true,
        check: async () => {},
        grant: () => {},
        setToolName: () => {},
      },
      tracer: {
        startActiveSpan: (
          _name: string,
          _opts: unknown,
          fn: (span: unknown) => unknown,
        ) =>
          fn({
            setStatus: () => {},
            recordException: () => {},
            end: () => {},
          }),
      },
      meter: {
        createHistogram: () => ({ record: () => {} }),
        createCounter: () => ({ add: () => {} }),
      },
      metadata: { requestId: "req_test", timestamp: new Date() },
    } as unknown as StudioContext;
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  const card = (status: TaskBoardItemStatus, title = `card in ${status}`) =>
    taskBoard.create({ organizationId: ORG, title, status, by: USER });

  const move = (id: string, status: TaskBoardItemStatus) =>
    TASK_BOARD_ITEM_UPDATE.handler({ id, status }, ctx);

  const moveAsRun = (id: string, status: TaskBoardItemStatus) =>
    taskRunContextStore.run({ threadId: "thrd_run" }, () => move(id, status));

  it("refuses a run moving a card out of QA or Customer Approval", async () => {
    const qa = await card("qa");
    await expect(moveAsRun(qa.id, "customer_approval")).rejects.toThrow(
      /A person moves a card out of "qa"/,
    );
    const approval = await card("customer_approval");
    await expect(
      moveAsRun(approval.id, "ready_for_deployment"),
    ).rejects.toThrow(/A person moves a card out of "customer_approval"/);
    expect((await taskBoard.getById(qa.id, ORG))?.status).toBe("qa");
  });

  it("refuses a run moving a card into a person's check or past it", async () => {
    const working = await card("in_progress");
    for (const status of [
      "qa",
      "customer_approval",
      "ready_for_deployment",
    ] as const) {
      await expect(moveAsRun(working.id, status)).rejects.toThrow(
        /QA and Customer Approval are for people/,
      );
    }
    expect((await taskBoard.getById(working.id, ORG))?.status).toBe(
      "in_progress",
    );
  });

  it("lets a run send a card back from QA, and a person move it on", async () => {
    const back = await card("qa");
    expect((await moveAsRun(back.id, "in_progress")).item.status).toBe(
      "in_progress",
    );
    const forward = await card("qa");
    expect((await move(forward.id, "customer_approval")).item.status).toBe(
      "customer_approval",
    );
  });

  it("refuses the previous board's lanes as a target", async () => {
    const triage = await card("triage");
    for (const status of ["todo", "approved", "merged"] as const) {
      await expect(move(triage.id, status)).rejects.toThrow(
        /not on this board/,
      );
    }
  });

  it("moves an approved card to QA and closes its review cycle", async () => {
    const reviewed = await card("in_progress", "approved by the reviewer");
    await taskBoard.update(
      reviewed.id,
      ORG,
      { assigneeId: SUPER_AGENT_ASSIGNEE_ID },
      USER,
    );
    const underReview = await taskBoard.openReviewCycleIfInProgress(
      reviewed.id,
      ORG,
    );
    expect(underReview?.status).toBe("in_review");

    const moved = await moveApprovedCardToQa(ctx, underReview!);

    expect(moved?.status).toBe("qa");
    expect(moved?.reviewCycleStartedAt).toBeNull();
    const activity = await taskBoard.listActivity(reviewed.id, ORG);
    expect(activity.at(-1)).toMatchObject({
      action: "status_changed",
      data: { from: "in_review", to: "qa" },
    });
  });

  it("does not move a card that left review to QA", async () => {
    const shipped = await card("post_deploy_validation");
    expect(await moveApprovedCardToQa(ctx, shipped)).toBeNull();
    expect((await taskBoard.getById(shipped.id, ORG))?.status).toBe(
      "post_deploy_validation",
    );
  });

  it("ships only from Ready for Deployment", async () => {
    for (const status of ["in_review", "qa", "customer_approval"] as const) {
      const notYet = await card(status);
      await expect(
        TASK_BOARD_PROMOTE_TO_PRODUCTION.handler(
          { taskBoardItemId: notYet.id },
          ctx,
        ),
      ).rejects.toThrow(/move it to Ready for Deployment first/);
    }
  });

  // Without `auto_merge` a person presses Ship; arriving must not merge.
  it("leaves a card in Ready for Deployment when the org merges by hand", async () => {
    const cleared = await card("customer_approval");
    const { item } = await move(cleared.id, "ready_for_deployment");
    expect(item.status).toBe("ready_for_deployment");
    const activity = await taskBoard.listActivity(cleared.id, ORG);
    expect(activity.some((a) => a.action === "merge_failed")).toBe(false);
  });
});
