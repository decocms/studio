/**
 * A run that moves its Jira issue on as its last step hands it to the next
 * status's automation. That fire must let the handing-over run finish instead
 * of stopping it mid-report; a move by a person still takes over at once.
 */
import { describe, expect, test } from "bun:test";
import type { TaskBoardItem, TaskBoardItemThreadRef } from "@/storage/types";
import { awaitHandoff, movedByIntegration } from "./jira-run";

const BOT = { accountId: "acc-bot", displayName: "Studio Bot" };
const client = { myself: async () => BOT };

const move = (accountId: string | null) => ({
  toStatus: "Code Review",
  fromStatus: "Doing",
  movedBy: accountId ? { accountId, displayName: accountId } : null,
  movedAt: "2026-10-15T00:00:00.000Z",
});

function thread(
  status: TaskBoardItemThreadRef["status"],
): TaskBoardItemThreadRef {
  return {
    threadId: "thrd_1",
    virtualMcpId: null,
    status,
    title: null,
    lastMessage: null,
    hasPreview: false,
    failureKind: null,
    hasMessages: true,
    lastActiveAt: "2026-10-15T00:00:00.000Z",
    costUsd: null,
    costProvider: null,
    createdAt: "2026-10-15T00:00:00.000Z",
  };
}

function item(threads: TaskBoardItemThreadRef[]): TaskBoardItem {
  return {
    id: "board_1",
    organizationId: "org_1",
    title: "Anchor",
    description: null,
    status: "in_progress",
    priority: "medium",
    type: "chore",
    assigneeId: null,
    assignedBy: null,
    repo: null,
    repositoryId: null,
    sprintId: null,
    dueDate: null,
    sortOrder: 0,
    keySeq: 1,
    externalUrl: null,
    previewRoutes: [],
    source: "jira",
    retryAttempts: 0,
    reviewCycleStartedAt: null,
    threads,
    tags: [],
    reviewVerdicts: [],
    statusSince: null,
    createdBy: "user_1",
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedBy: "user_1",
    updatedAt: "2026-10-15T00:00:00.000Z",
  };
}

/** A board whose anchor reads back with each status in turn. */
function boardReading(...statuses: TaskBoardItemThreadRef["status"][]) {
  let reads = 0;
  return {
    get reads() {
      return reads;
    },
    storage: {
      taskBoard: {
        getById: async () =>
          item([
            thread(statuses[Math.min(reads++, statuses.length - 1)] ?? null),
          ]),
      },
    },
  };
}

describe("movedByIntegration", () => {
  test("a move by the integration's own account is a handoff", async () => {
    expect(await movedByIntegration(client, move("acc-bot"))).toBe(true);
  });

  test("a move by a person is not", async () => {
    expect(await movedByIntegration(client, move("acc-ana"))).toBe(false);
  });

  test("a move with no author is not", async () => {
    expect(await movedByIntegration(client, move(null))).toBe(false);
  });

  test("an unreadable account is not, so the fire takes over as before", async () => {
    const failing = {
      myself: async (): Promise<typeof BOT> => {
        throw new Error("401");
      },
    };
    expect(await movedByIntegration(failing, move("acc-bot"))).toBe(false);
  });
});

describe("awaitHandoff", () => {
  test("waits for the live run to finish", async () => {
    const board = boardReading("in_progress", "completed");
    const after = await awaitHandoff(board, item([thread("in_progress")]), {
      pollMs: 1,
    });
    expect(after.threads.map((t) => t.status)).toEqual(["completed"]);
    expect(board.reads).toBe(2);
  });

  test("does not wait when nothing is running", async () => {
    const board = boardReading("completed");
    await awaitHandoff(board, item([thread("failed")]), { pollMs: 1 });
    expect(board.reads).toBe(0);
  });

  test("gives up at the deadline, leaving the run to be taken over", async () => {
    const board = boardReading("in_progress");
    const after = await awaitHandoff(board, item([thread("in_progress")]), {
      timeoutMs: 20,
      pollMs: 5,
    });
    expect(after.threads.map((t) => t.status)).toEqual(["in_progress"]);
  });
});
