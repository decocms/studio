import { describe, expect, test } from "bun:test";
import { resolveTaskBranch } from "./task-branch";

describe("resolveTaskBranch", () => {
  test("no sessions → null", () => {
    expect(resolveTaskBranch([])).toBeNull();
  });

  test("sessions without a branch → null (the server picks)", () => {
    // The shape the local dev org is in: three linked sessions, no branch.
    expect(
      resolveTaskBranch([
        { threadId: "a", createdAt: "2026-08-01T00:00:00Z", branch: null },
        { threadId: "b", createdAt: "2026-08-02T00:00:00Z" },
        { threadId: "c", createdAt: "2026-08-03T00:00:00Z", branch: "" },
      ]),
    ).toBeNull();
  });

  test("single branched session wins", () => {
    expect(
      resolveTaskBranch([
        {
          threadId: "a",
          createdAt: "2026-08-01T00:00:00Z",
          branch: "thread:a",
        },
      ]),
    ).toBe("thread:a");
  });

  test("newest branch wins, whatever the input order", () => {
    expect(
      resolveTaskBranch([
        { threadId: "old", createdAt: "2026-08-01T00:00:00Z", branch: "old" },
        { threadId: "new", createdAt: "2026-08-09T00:00:00Z", branch: "new" },
        { threadId: "mid", createdAt: "2026-08-05T00:00:00Z", branch: "mid" },
      ]),
    ).toBe("new");
  });

  test("skips newer branchless sessions to find the branch in use", () => {
    expect(
      resolveTaskBranch([
        { threadId: "newest", createdAt: "2026-08-09T00:00:00Z", branch: null },
        {
          threadId: "older",
          createdAt: "2026-08-01T00:00:00Z",
          branch: "thread:older",
        },
      ]),
    ).toBe("thread:older");
  });

  test("whitespace-only branch is not a branch", () => {
    expect(
      resolveTaskBranch([
        { threadId: "a", createdAt: "2026-08-01T00:00:00Z", branch: "   " },
      ]),
    ).toBeNull();
  });

  test("trims the branch it returns", () => {
    expect(
      resolveTaskBranch([
        {
          threadId: "a",
          createdAt: "2026-08-01T00:00:00Z",
          branch: " feat/x ",
        },
      ]),
    ).toBe("feat/x");
  });

  test("does not mutate the input order", () => {
    const sessions = [
      { threadId: "old", createdAt: "2026-08-01T00:00:00Z", branch: "old" },
      { threadId: "new", createdAt: "2026-08-09T00:00:00Z", branch: "new" },
    ];
    resolveTaskBranch(sessions);
    expect(sessions.map((s) => s.threadId)).toEqual(["old", "new"]);
  });
});
