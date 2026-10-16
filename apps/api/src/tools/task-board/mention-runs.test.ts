import { describe, expect, it } from "bun:test";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import type { TaskBoardItem } from "@/storage/types";
import { routeComment, runCommentParent } from "./mention-runs";

const MENTION = `[@Super Agent](mention:${SUPER_AGENT_ASSIGNEE_ID}) take a look`;

type Run = Pick<
  TaskBoardItem["threads"][number],
  "threadId" | "status" | "failureKind" | "createdAt"
>;
const run = (threadId: string, status: Run["status"], extra = {}): Run => ({
  threadId,
  status,
  failureKind: null,
  createdAt: "2026-10-16T00:00:00.000Z",
  ...extra,
});
const card = (...threads: Run[]) =>
  ({ threads }) as unknown as Pick<TaskBoardItem, "threads">;

const comment = (
  id: string,
  over: {
    parentId?: string;
    threadId?: string;
    authorId?: string;
    audience?: "human" | "internal";
  } = {},
) => ({
  id,
  parentId: over.parentId ?? null,
  threadId: over.threadId ?? null,
  authorId: over.authorId ?? "u1",
  audience: over.audience ?? ("human" as const),
});

describe("routeComment", () => {
  it("leaves a comment that is not for the Super Agent alone", () => {
    expect(routeComment(card(), [], { body: "looks good" })).toBeNull();
  });

  it("starts a run for a mention on a card with no run working", () => {
    expect(
      routeComment(card(run("t-old", "completed")), [], { body: MENTION }),
    ).toEqual({ kind: "start", tie: null });
  });

  it("makes a plain conversation the run's when the mention is a reply in it", () => {
    const comments = [comment("root")];
    expect(
      routeComment(card(), comments, { body: MENTION, parentId: "root" }),
    ).toEqual({ kind: "start", tie: "root" });
  });

  it("sends a mention to the run in progress, under the comment that started it", () => {
    const comments = [comment("root", { threadId: "t-live" })];
    expect(
      routeComment(card(run("t-live", "in_progress")), comments, {
        body: MENTION,
      }),
    ).toEqual({
      kind: "send",
      threadId: "t-live",
      parentId: "root",
      tieNew: false,
    });
  });

  it("ties a mention to a run in progress no comment started", () => {
    expect(
      routeComment(card(run("t-board", "requires_action")), [], {
        body: MENTION,
      }),
    ).toEqual({
      kind: "send",
      threadId: "t-board",
      parentId: null,
      tieNew: true,
    });
  });

  it("sends a mention to a board run in progress, under the comment that opened its thread", () => {
    const comments = [
      comment("opened", {
        threadId: "t-board",
        authorId: SUPER_AGENT_ASSIGNEE_ID,
      }),
    ];
    expect(
      routeComment(card(run("t-board", "in_progress")), comments, {
        body: MENTION,
      }),
    ).toEqual({
      kind: "send",
      threadId: "t-board",
      parentId: "opened",
      tieNew: false,
    });
  });

  it("does not hang a mention off the agent's handoff note", () => {
    const comments = [
      comment("agent-note", {
        threadId: "t-live",
        authorId: SUPER_AGENT_ASSIGNEE_ID,
        audience: "internal",
      }),
    ];
    expect(
      routeComment(card(run("t-live", "in_progress")), comments, {
        body: MENTION,
      }),
    ).toMatchObject({ parentId: null, tieNew: true });
  });

  it("sends a reply in a run's thread to that run, @ or not", () => {
    const comments = [comment("root", { threadId: "t-live" })];
    expect(
      routeComment(card(run("t-live", "in_progress")), comments, {
        body: "also the listing",
        parentId: "root",
      }),
    ).toEqual({
      kind: "send",
      threadId: "t-live",
      parentId: "root",
      tieNew: false,
    });
  });

  it("resumes a finished run from a reply in its thread", () => {
    const comments = [
      comment("root", { threadId: "t-done" }),
      comment("r1", { parentId: "root", authorId: SUPER_AGENT_ASSIGNEE_ID }),
    ];
    expect(
      routeComment(card(run("t-done", "completed")), comments, {
        body: "one more thing",
        parentId: "r1",
      }),
    ).toEqual({
      kind: "send",
      threadId: "t-done",
      parentId: "r1",
      tieNew: false,
    });
  });

  it("refuses to resume a run while another works the card", () => {
    const comments = [comment("root", { threadId: "t-done" })];
    expect(() =>
      routeComment(
        card(run("t-done", "completed"), run("t-live", "in_progress")),
        comments,
        { body: "one more thing", parentId: "root" },
      ),
    ).toThrow(/Another run is working on this card/);
  });

  it("does not count a superseded run as working the card", () => {
    expect(
      routeComment(
        card(run("t-old", "in_progress", { failureKind: "superseded" })),
        [],
        { body: MENTION },
      ),
    ).toEqual({ kind: "start", tie: null });
  });

  it("treats a run thread whose run left the card as a plain conversation", () => {
    const comments = [comment("root", { threadId: "t-gone" })];
    expect(
      routeComment(card(), comments, { body: "hi", parentId: "root" }),
    ).toBeNull();
  });
});

describe("runCommentParent", () => {
  it("answers under the person's comment tied to the run, not a handoff note", () => {
    const comments = [
      comment("agent-note", {
        threadId: "t1",
        authorId: SUPER_AGENT_ASSIGNEE_ID,
        audience: "internal",
      }),
      comment("person-root", { threadId: "t1" }),
      comment("reply", { parentId: "person-root", threadId: "t1" }),
    ];
    expect(runCommentParent(comments, "t1")?.id).toBe("person-root");
    expect(runCommentParent(comments, "t2")).toBeNull();
  });

  it("writes a board run's comments under the one that opened its thread", () => {
    const comments = [
      comment("opened", { threadId: "t1", authorId: SUPER_AGENT_ASSIGNEE_ID }),
    ];
    expect(runCommentParent(comments, "t1")?.id).toBe("opened");
  });
});
