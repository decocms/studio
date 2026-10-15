import { describe, expect, it } from "bun:test";
import { isRepoBacked, shouldAdvanceToReview } from "./task-board";

/** A thread that was actually used — the default for these cases. */
const thread = (
  status: string | null,
  hasMessages = true,
): { status: string | null; hasMessages: boolean } => ({
  status,
  hasMessages,
});

/** Created and never typed in: born `completed`, must not count. */
const emptyThread = () => thread("completed", false);

describe("shouldAdvanceToReview", () => {
  it("advances an in_progress, repo-less task whose only thread completed", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [thread("completed")],
      }),
    ).toBe(true);
  });

  // A repo-backed task that finished with no PR has nothing to review yet.
  it("does NOT advance a repo-backed task on finish with no PR", () => {
    expect(
      shouldAdvanceToReview(
        {
          status: "in_progress",
          repo: "acme/site",
          threads: [thread("completed")],
        },
        false,
      ),
    ).toBe(false);
  });

  // Backstop for missed PR-open detection: a PR exists, so finishing means there is one to review.
  it("advances a repo-backed task on finish once a PR is linked", () => {
    expect(
      shouldAdvanceToReview(
        {
          status: "in_progress",
          repo: "acme/site",
          threads: [thread("completed")],
        },
        true,
      ),
    ).toBe(true);
  });

  /**
   * `EXPERIMENT_IMPLEMENT` creates its card with `repositoryId` and no `repo`.
   * Read as repo-less, such a card took the "its answer IS its deliverable"
   * branch to QA the moment its run finished — past the reviewers, and past
   * every sweeper that only visits cards still In Progress, so the pull
   * request its run had opened was never linked and the experiment screen sat
   * on "the agent is writing the code" forever.
   */
  it("does NOT advance a card repo-backed by id alone with no PR", () => {
    expect(
      shouldAdvanceToReview(
        {
          status: "in_progress",
          repositoryId: "repo_1",
          threads: [thread("completed")],
        },
        false,
      ),
    ).toBe(false);
  });

  it("advances a card repo-backed by id alone once a PR is linked", () => {
    expect(
      shouldAdvanceToReview(
        {
          status: "in_progress",
          repositoryId: "repo_1",
          threads: [thread("completed")],
        },
        true,
      ),
    ).toBe(true);
  });

  // Inverted deliberately: this used to assert that a failed run advances the
  // card. It is how eight tasks whose sandboxes never came up landed In Review
  // with no PR and no work done. In Review means there is something to review.
  it("does NOT advance a task whose only run failed", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [thread("failed")],
      }),
    ).toBe(false);
  });

  it("does NOT advance a task whose only run expired", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [thread("expired")],
      }),
    ).toBe(false);
  });

  // A retry that worked must still reach the reviewers, so the rule is "some run
  // completed", never "the newest one did".
  it("advances when an earlier failure was followed by a completed re-run", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [thread("failed"), thread("completed")],
      }),
    ).toBe(true);
  });

  it("requires EVERY thread to be terminal", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [thread("completed"), thread("in_progress")],
      }),
    ).toBe(false);
  });

  it("does not advance while a thread is paused on user_ask (requires_action)", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [thread("requires_action")],
      }),
    ).toBe(false);
  });

  it("advances a repo-backed task on thread-finish too (backstop for missed PR detection)", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [thread("completed")],
      }),
    ).toBe(true);
  });

  it("only fires from in_progress, not from other lanes", () => {
    for (const status of ["triage", "todo", "in_review", "done"] as const) {
      expect(
        shouldAdvanceToReview({ status, threads: [thread("completed")] }),
      ).toBe(false);
    }
  });

  it("does not advance a task with no threads", () => {
    expect(shouldAdvanceToReview({ status: "in_progress", threads: [] })).toBe(
      false,
    );
  });

  // Clicking "New chat" persists the row before anything is typed, and `create`
  // defaults status to "completed" — so an empty chat is born terminal. Prod
  // card board_zsKGcXRC9IhyqY_rNHekN sat In Progress on exactly this.
  it("ignores a thread that was created and never used", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [emptyThread()],
      }),
    ).toBe(false);
  });

  it("advances on the used thread, ignoring an empty one beside it", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [emptyThread(), thread("completed")],
      }),
    ).toBe(true);
  });

  it("an empty thread cannot mask a still-running one", () => {
    expect(
      shouldAdvanceToReview({
        status: "in_progress",
        threads: [emptyThread(), thread("in_progress")],
      }),
    ).toBe(false);
  });
});

describe("isRepoBacked", () => {
  it("is true for either column", () => {
    expect(isRepoBacked({ repo: "acme/site" })).toBe(true);
    expect(isRepoBacked({ repositoryId: "repo_1" })).toBe(true);
    expect(isRepoBacked({ repo: "acme/site", repositoryId: "repo_1" })).toBe(
      true,
    );
  });

  it("is false only when a card names no repository at all", () => {
    expect(isRepoBacked({})).toBe(false);
    expect(isRepoBacked({ repo: null, repositoryId: null })).toBe(false);
  });
});
