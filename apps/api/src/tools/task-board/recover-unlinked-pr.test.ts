/**
 * The card that said "the agent is still writing the code" with its pull
 * request already open: `capturePrForRun` missed the link and the sweeper only
 * looks a PR up by branch once the RUN HAS FINISHED, so a run that opens its
 * PR and keeps working left the experiments view spinning on a stage it could
 * never leave. `recoverUnlinkedPr` is the lookup on the read path; the branch
 * lookup it delegates to is covered by `pr-by-branch.test.ts`.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem, TaskBoardItemPrRef } from "@/storage/types";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";

const linkPrFromRunBranch = mock(async () => false);
mock.module("./pr-by-branch", () => ({ linkPrFromRunBranch }));

const { claimUnlinkedLookup, recoverUnlinkedPr } = await import("./prs-get");

const ORG = "org_1";
const ITEM_ID = "item_1";

const pr: TaskBoardItemPrRef = {
  repoOwner: "deco",
  repoName: "studio",
  number: 7,
  url: "https://github.com/deco/studio/pull/7",
  connectionId: "conn_1",
  repositoryId: null,
  createdAt: new Date(0).toISOString(),
};

const item = (overrides: Partial<TaskBoardItem> = {}) =>
  ({
    id: ITEM_ID,
    organizationId: ORG,
    assigneeId: SUPER_AGENT_ASSIGNEE_ID,
    ...overrides,
  }) as TaskBoardItem;

/** `listPrs` answers whatever the linking left behind. */
const ctxWith = (listPrs: () => Promise<TaskBoardItemPrRef[]>) =>
  ({ storage: { taskBoard: { listPrs } } }) as unknown as StudioContext;

/** Each test gets its own card id so the per-card throttle never leaks
 *  between them — it is module state on purpose. */
let seq = 0;
const freshItemId = () => `${ITEM_ID}_${++seq}`;

beforeEach(() => {
  linkPrFromRunBranch.mockClear();
});

describe("recoverUnlinkedPr", () => {
  it("returns the linked PRs untouched and never asks the provider", async () => {
    const ctx = ctxWith(async () => [pr]);
    const out = await recoverUnlinkedPr(ctx, ORG, item(), {
      linked: [pr],
      taskBoardItemId: freshItemId(),
    });
    expect(out).toEqual([pr]);
    expect(linkPrFromRunBranch).not.toHaveBeenCalled();
  });

  it("links the PR open on the run's branch and re-reads it", async () => {
    linkPrFromRunBranch.mockImplementation(async () => true);
    const ctx = ctxWith(async () => [pr]);
    const out = await recoverUnlinkedPr(ctx, ORG, item(), {
      linked: [],
      taskBoardItemId: freshItemId(),
    });
    expect(out).toEqual([pr]);
    expect(linkPrFromRunBranch).toHaveBeenCalledTimes(1);
  });

  it("stays empty when the branch holds no change request", async () => {
    linkPrFromRunBranch.mockImplementation(async () => false);
    const ctx = ctxWith(async () => {
      throw new Error("must not re-read when nothing was linked");
    });
    const out = await recoverUnlinkedPr(ctx, ORG, item(), {
      linked: [],
      taskBoardItemId: freshItemId(),
    });
    expect(out).toEqual([]);
  });

  it("leaves a human's card alone", async () => {
    const ctx = ctxWith(async () => []);
    await recoverUnlinkedPr(ctx, ORG, item({ assigneeId: "user_1" }), {
      linked: [],
      taskBoardItemId: freshItemId(),
    });
    expect(linkPrFromRunBranch).not.toHaveBeenCalled();
  });

  it("leaves a deleted card alone", async () => {
    const ctx = ctxWith(async () => []);
    await recoverUnlinkedPr(ctx, ORG, null, {
      linked: [],
      taskBoardItemId: freshItemId(),
    });
    expect(linkPrFromRunBranch).not.toHaveBeenCalled();
  });

  it("looks a card up once per window, however many viewers poll it", async () => {
    linkPrFromRunBranch.mockImplementation(async () => false);
    const ctx = ctxWith(async () => []);
    const taskBoardItemId = freshItemId();
    for (let i = 0; i < 5; i++) {
      await recoverUnlinkedPr(ctx, ORG, item(), {
        linked: [],
        taskBoardItemId,
      });
    }
    expect(linkPrFromRunBranch).toHaveBeenCalledTimes(1);
  });

  it("throttles per organization and card, not globally", () => {
    expect(claimUnlinkedLookup(`${ORG}:a`)).toBe(true);
    expect(claimUnlinkedLookup(`${ORG}:a`)).toBe(false);
    expect(claimUnlinkedLookup(`${ORG}:b`)).toBe(true);
    expect(claimUnlinkedLookup(`org_2:a`)).toBe(true);
  });
});
