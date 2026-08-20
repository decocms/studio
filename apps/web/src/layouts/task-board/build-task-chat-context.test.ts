import { describe, expect, test } from "bun:test";
import { buildTaskChatContext } from "./build-task-chat-context";
import type { TaskBoardItemPr, TaskBoardItemThread } from "./config";

const thread = (o: Partial<TaskBoardItemThread>): TaskBoardItemThread => ({
  threadId: "t",
  virtualMcpId: null,
  status: null,
  title: null,
  lastMessage: null,
  hasPreview: false,
  failureKind: null,
  hasMessages: false,
  costUsd: null,
  costProvider: null,
  createdAt: "",
  lastActiveAt: "",
  ...o,
});

const pr = (o: Partial<TaskBoardItemPr>): TaskBoardItemPr => ({
  url: "https://gh/x/y/pull/1",
  number: 1,
  repoOwner: "x",
  repoName: "y",
  createdAt: "",
  title: null,
  body: null,
  state: "open",
  draft: false,
  merged: false,
  mergeable: null,
  checksStatus: null,
  checks: [],
  previewUrl: null,
  ...o,
});

describe("buildTaskChatContext", () => {
  test("title-only task yields just the heading", () => {
    expect(
      buildTaskChatContext({
        title: "Fix login",
        description: null,
        threads: [],
      }),
    ).toBe("# Task: Fix login");
  });

  test("includes description, PRs, and other chats", () => {
    const out = buildTaskChatContext(
      {
        title: "Fix login",
        description: "Broken on Safari.",
        threads: [thread({ title: "First attempt", status: "failed" })],
      },
      [
        pr({
          number: 42,
          title: "Patch auth",
          merged: true,
          url: "https://pr/42",
        }),
      ],
    );
    expect(out).toContain("# Task: Fix login");
    expect(out).toContain("Broken on Safari.");
    expect(out).toContain("## Linked pull requests");
    expect(out).toContain("#42 Patch auth [merged] https://pr/42");
    expect(out).toContain("## Other chats on this task");
    expect(out).toContain("First attempt [failed]");
  });

  test("PR state falls back to draft/open when live state is null", () => {
    const out = buildTaskChatContext(
      { title: "T", description: null, threads: [] },
      [pr({ state: null, draft: true, repoOwner: "o", repoName: "r" })],
    );
    expect(out).toContain("o/r [draft]");
  });
});
