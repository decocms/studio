/** applyBoardDecision writes across task_board_items, _prs, _threads and
 *  _comments and reads status back — an in-memory fake wouldn't reproduce the
 *  update whitelist or the link tables, so this runs against real Postgres. */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import { sql } from "kysely";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../../database/test-db-pg";
import { TaskBoardStorage } from "../../storage/task-board";
import type { TaskBoardItem } from "../../storage/types";
import type { ExtractedPr } from "./pr-extract";
import {
  applyBoardDecision,
  type BoardDecision,
} from "./pr-open-board-reaction";

/** Studio's own board, which is what these fixtures run on. */
const CANON_COLUMNS = [
  "triage",
  "todo",
  "in_progress",
  "in_review",
  "approved",
  "merged",
  "post_deploy_validation",
  "done",
  "archived",
].map((key, position) => ({
  key,
  title: key,
  position,
  role: key,
  trackerStatuses: [],
}));
const CANON_LANES = {
  intake: "triage",
  queue: "todo",
  progress: "in_progress",
  review: "in_review",
  archive: "archived",
};

const ORG = "org_propen_1";
const USER = "user_propen_1";
const PR: ExtractedPr = {
  url: "https://github.com/acme/widget/pull/7",
  number: 7,
  owner: "acme",
  repo: "widget",
};

describe("applyBoardDecision", () => {
  let database: StudioDatabase;
  let taskBoard: TaskBoardStorage;

  const THREADS = [
    "thr_create",
    "thr_update",
    "thr_human",
    "thr_fallback",
    "thr_done",
  ];

  const apply = (
    decision: BoardDecision,
    openCards: TaskBoardItem[],
    thread: string,
  ) =>
    applyBoardDecision(taskBoard, {
      orgId: ORG,
      userId: USER,
      threadId: thread,
      pr: PR,
      lanes: CANON_LANES,
      columns: CANON_COLUMNS,
      decision,
      openCards,
    });

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    await database.db
      .insertInto("organization")
      .values([{ id: ORG, name: ORG, slug: "org-propen-1", createdAt: now }])
      .execute();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"propen@propen.test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    // linkThread FKs the thread row, so referenced threads must exist.
    await database.db
      .insertInto("threads")
      .values(
        THREADS.map((id) => ({
          id,
          organization_id: ORG,
          created_by: USER,
          title: id,
          status: "completed",
          virtual_mcp_id: "",
          created_at: now,
          updated_at: now,
        })),
      )
      .execute();
    taskBoard = new TaskBoardStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  // Inverted with migration 190: a PR used to put the card In Review. It now
  // opens the card's REVIEW CYCLE and leaves the lane at In Progress — an agent
  // reviewer is about to work on it, and In Review is what the board says once
  // it is a person's turn.
  it("create: opens a new card under review with the PR and thread linked", async () => {
    const item = await apply(
      {
        action: "create",
        title: "Ship the widget",
        comment: "left the CSS alone",
      },
      [],
      "thr_create",
    );
    expect(item).not.toBeNull();
    expect(item!.status).toBe("in_progress");
    expect(item!.reviewCycleStartedAt).not.toBeNull();
    expect(item!.title).toBe("Ship the widget");
    // Owned by the Super Agent — otherwise the reviewers never pick the card up.
    expect(item!.assigneeId).toBe(SUPER_AGENT_ASSIGNEE_ID);

    const prs = await taskBoard.listPrs(item!.id, ORG);
    expect(prs.map((p) => p.number)).toEqual([7]);

    const linked = await taskBoard.linkedTaskIds("thr_create", ORG);
    expect(linked).toContain(item!.id);

    const comments = await taskBoard.listComments(item!.id, ORG);
    expect(comments.map((c) => c.body)).toContain("left the CSS alone");
  });

  it("update: opens the review cycle on an in-progress card and links the PR", async () => {
    const card = await taskBoard.create({
      organizationId: ORG,
      title: "Existing work",
      status: "in_progress",
      by: USER,
    });
    const item = await apply(
      { action: "update", taskId: card.id },
      [card],
      "thr_update",
    );
    expect(item!.id).toBe(card.id);
    expect(item!.status).toBe("in_progress");
    expect(item!.reviewCycleStartedAt).not.toBeNull();
    // Was unassigned, so entering the review phase claims it for the Super Agent.
    expect(item!.assigneeId).toBe(SUPER_AGENT_ASSIGNEE_ID);
    const prs = await taskBoard.listPrs(card.id, ORG);
    expect(prs.map((p) => p.number)).toEqual([7]);
    expect(await taskBoard.linkedTaskIds("thr_update", ORG)).toContain(card.id);
  });

  it("update leaves a human assignee in place when entering review", async () => {
    const card = await taskBoard.create({
      organizationId: ORG,
      title: "human owned",
      status: "in_progress",
      assigneeId: USER,
      by: USER,
    });
    const item = await apply(
      { action: "update", taskId: card.id },
      [card],
      "thr_human",
    );
    expect(item!.id).toBe(card.id);
    expect(item!.status).toBe("in_progress");
    expect(item!.reviewCycleStartedAt).not.toBeNull();
    // A human owns it — the claim must not steal the card from them.
    expect(item!.assigneeId).toBe(USER);
  });

  it("update with an unknown taskId falls back to creating a card", async () => {
    const card = await taskBoard.create({
      organizationId: ORG,
      title: "unrelated",
      status: "in_progress",
      by: USER,
    });
    const item = await apply(
      { action: "update", taskId: "board_does_not_exist" },
      [card],
      "thr_fallback",
    );
    expect(item).not.toBeNull();
    expect(item!.id).not.toBe(card.id);
    expect(item!.status).toBe("in_progress");
    expect(item!.reviewCycleStartedAt).not.toBeNull();
    expect(await taskBoard.linkedTaskIds("thr_fallback", ORG)).toContain(
      item!.id,
    );
  });

  it("update never regresses a done card, but still links the PR", async () => {
    const card = await taskBoard.create({
      organizationId: ORG,
      title: "already shipped",
      status: "done",
      by: USER,
    });
    const item = await apply(
      { action: "update", taskId: card.id },
      [card],
      "thr_done",
    );
    expect(item!.id).toBe(card.id);
    expect(item!.status).toBe("done");
    // A terminal card is not advanced, so it is not claimed either — and no
    // reviewer is put on work that already shipped.
    expect(item!.assigneeId).toBeNull();
    expect(item!.reviewCycleStartedAt).toBeNull();
    const prs = await taskBoard.listPrs(card.id, ORG);
    expect(prs.map((p) => p.number)).toEqual([7]);
  });
});
