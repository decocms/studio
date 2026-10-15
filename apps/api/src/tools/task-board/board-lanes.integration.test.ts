/**
 * Real-Postgres coverage for the board's lanes: who may move a card under
 * review, an approval landing in QA, and the merge starting only from Ready
 * for Deployment.
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
import {
  OrgScopedThreadStorage,
  SqlThreadStorage,
} from "../../storage/threads";
import { TASK_RUN_INSTRUCTIONS_KEY } from "../../harnesses/claude-code-env";
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
        threads: new OrgScopedThreadStorage(
          new SqlThreadStorage(database.db),
          ORG,
        ),
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

  /** A thread on the MCP endpoint every sandbox-hosted run shares: a chat,
   *  or a run the board dispatched (which carries its task instructions). */
  const thread = async (boardRun: boolean) =>
    new SqlThreadStorage(database.db).create({
      organization_id: ORG,
      title: boardRun ? "Super Agent: a card" : "a chat",
      status: "in_progress",
      message_storage_version: 2,
      created_by: USER,
      ...(boardRun
        ? { metadata: { [TASK_RUN_INSTRUCTIONS_KEY]: "work on the card" } }
        : {}),
    });

  const moveFrom =
    (threadId: string) => (id: string, status: TaskBoardItemStatus) =>
      taskRunContextStore.run({ threadId }, () => move(id, status));

  /** A card the reviewer is working on. */
  const underReview = async () => {
    const created = await card("in_progress", "under review");
    await taskBoard.openReviewCycleIfInProgress(created.id, ORG);
    return created;
  };

  it("lets a chat move a card through review and the people's checks", async () => {
    const asChat = moveFrom((await thread(false)).id);
    const { id } = await underReview();
    for (const status of [
      "qa",
      "customer_approval",
      "ready_for_deployment",
    ] as const) {
      expect((await asChat(id, status)).item.status).toBe(status);
    }
  });

  it("refuses the board's own run moving its card past In Review", async () => {
    const asRun = moveFrom((await thread(true)).id);
    const { id } = await underReview();
    for (const status of ["qa", "done"] as const) {
      await expect(asRun(id, status)).rejects.toThrow(
        /can't move it past In Review/,
      );
    }
    expect((await taskBoard.getById(id, ORG))?.status).toBe("in_review");
    // Sending it back to work stays open.
    expect((await asRun(id, "in_progress")).item.status).toBe("in_progress");
  });

  // A task that needed no change is finished by its own run.
  it("lets the board's run finish a card that is not under review", async () => {
    const asRun = moveFrom((await thread(true)).id);
    const working = await card("in_progress", "no change needed");
    expect((await asRun(working.id, "done")).item.status).toBe("done");
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
