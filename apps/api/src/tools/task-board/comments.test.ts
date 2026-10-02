import { describe, expect, it, mock } from "bun:test";
import {
  TASK_BOARD_COMMENT_CREATE,
  TASK_BOARD_COMMENT_LIST,
  TASK_BOARD_COMMENT_UPDATE,
} from "./comments";
import { taskRunContextStore } from "./task-run-context";

type Ctx = Parameters<typeof TASK_BOARD_COMMENT_LIST.handler>[1];

/** What the comment composer stores for an attached file. */
const STORED =
  "see [spec.pdf](/api/acme/fs/uploads/read?path=editor-files%2Fspec.pdf)";
/** The same body as a sandboxed run should read it. */
const IN_SANDBOX = "see [spec.pdf](org/.uploads/editor-files/spec.pdf)";

function commentRow(body: string) {
  return {
    id: "cmt_1",
    taskBoardItemId: "tbi_1",
    parentId: null,
    authorId: "u1",
    threadId: null,
    body,
    resolved: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeCtx() {
  const createComment = mock(async (row: { body: string }) =>
    commentRow(row.body),
  );
  const updateComment = mock(async (row: { body?: string }) =>
    commentRow(row.body ?? STORED),
  );
  const ctx = {
    auth: { user: { id: "u1" } },
    organization: { id: "org_1", slug: "acme" },
    access: { check: mock(async () => {}) },
    storage: {
      taskBoard: {
        listComments: mock(async () => [commentRow(STORED)]),
        getComment: mock(async () => commentRow(STORED)),
        createComment,
        updateComment,
      },
      notifications: {
        notify: mock(async () => {}),
        notifyMentions: mock(async () => {}),
      },
    },
  } as unknown as Ctx;
  return { ctx, createComment, updateComment };
}

const inRun = <T>(fn: () => Promise<T>) =>
  taskRunContextStore.run({ threadId: "thrd_run" }, fn);

describe("attached files in comments a task run reads and writes", () => {
  it("a run lists them as sandbox paths it can Read", async () => {
    const { ctx } = makeCtx();
    const { comments } = await inRun(() =>
      TASK_BOARD_COMMENT_LIST.handler({ taskBoardItemId: "tbi_1" }, ctx),
    );
    expect(comments.map((c) => c.body)).toEqual([IN_SANDBOX]);
  });

  it("everyone else lists the stored URL a browser loads", async () => {
    const { ctx } = makeCtx();
    const { comments } = await TASK_BOARD_COMMENT_LIST.handler(
      { taskBoardItemId: "tbi_1" },
      ctx,
    );
    expect(comments.map((c) => c.body)).toEqual([STORED]);
  });

  it("a run that writes a sandbox path back stores the URL again", async () => {
    const { ctx, createComment } = makeCtx();
    await inRun(() =>
      TASK_BOARD_COMMENT_CREATE.handler(
        { taskBoardItemId: "tbi_1", body: IN_SANDBOX },
        ctx,
      ),
    );
    expect(createComment.mock.calls[0]?.[0].body).toBe(STORED);
  });

  it("a person's text is stored as typed, even if it names a sandbox path", async () => {
    const { ctx, createComment } = makeCtx();
    await TASK_BOARD_COMMENT_CREATE.handler(
      { taskBoardItemId: "tbi_1", body: IN_SANDBOX },
      ctx,
    );
    expect(createComment.mock.calls[0]?.[0].body).toBe(IN_SANDBOX);
  });
});

/**
 * Regression: comment bodies had no length cap — an unbounded `text` column,
 * writable directly by any org member's tool call. A single oversized POST
 * could bloat a row (and everything that re-reads it: the activity feed, the
 * Jira mirror, agent prompt context) with no server-side limit at all.
 */
describe("task board comment body length", () => {
  it("TASK_BOARD_COMMENT_CREATE rejects a body over the cap", () => {
    const result = TASK_BOARD_COMMENT_CREATE.inputSchema.safeParse({
      taskBoardItemId: "tbi_1",
      body: "x".repeat(50_001),
    });
    expect(result.success).toBe(false);
  });

  it("TASK_BOARD_COMMENT_CREATE accepts a body at the cap", () => {
    const result = TASK_BOARD_COMMENT_CREATE.inputSchema.safeParse({
      taskBoardItemId: "tbi_1",
      body: "x".repeat(50_000),
    });
    expect(result.success).toBe(true);
  });

  it("TASK_BOARD_COMMENT_UPDATE rejects a body over the cap", () => {
    const result = TASK_BOARD_COMMENT_UPDATE.inputSchema.safeParse({
      id: "cmt_1",
      body: "x".repeat(50_001),
    });
    expect(result.success).toBe(false);
  });
});
