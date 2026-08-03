import { describe, expect, test } from "bun:test";
import { inProgressSiblingReviewerThreadIds } from "./cancel-sibling-reviewers";

const thread = (
  threadId: string,
  title: string | null,
  status: string | null,
) => ({ threadId, title, status });

describe("inProgressSiblingReviewerThreadIds", () => {
  test("returns the other reviewer's in_progress thread", () => {
    const threads = [
      thread("qa", "QA Agent: Add SRI", "completed"),
      thread("cr", "Code Reviewer: Add SRI", "in_progress"),
    ];
    // QA is deciding → cancel the still-running Code Reviewer.
    expect(inProgressSiblingReviewerThreadIds(threads, "qa")).toEqual(["cr"]);
  });

  test("never cancels the deciding reviewer's own thread", () => {
    const threads = [thread("qa", "QA Agent: Add SRI", "in_progress")];
    expect(inProgressSiblingReviewerThreadIds(threads, "qa")).toEqual([]);
  });

  test("ignores terminal sibling threads", () => {
    const threads = [
      thread("cr1", "Code Reviewer: Add SRI", "completed"),
      thread("cr2", "Code Reviewer: Add SRI", "failed"),
      thread("cr3", "Code Reviewer: Add SRI", "expired"),
    ];
    expect(inProgressSiblingReviewerThreadIds(threads, "qa")).toEqual([]);
  });

  test("ignores a sibling paused in requires_action (human owns it)", () => {
    const threads = [thread("cr", "Code Reviewer: Add SRI", "requires_action")];
    expect(inProgressSiblingReviewerThreadIds(threads, "qa")).toEqual([]);
  });

  test("ignores null-status and non-reviewer threads", () => {
    const threads = [
      thread("cr", "Code Reviewer: Add SRI", null),
      thread("sa", "Super Agent: Add SRI", "in_progress"),
      thread("plain", "Some chat", "in_progress"),
    ];
    expect(inProgressSiblingReviewerThreadIds(threads, "qa")).toEqual([]);
  });

  test("code_review deciding cancels the running QA sibling", () => {
    const threads = [
      thread("qa", "QA Agent: Add SRI", "in_progress"),
      thread("cr", "Code Reviewer: Add SRI", "in_progress"),
    ];
    expect(inProgressSiblingReviewerThreadIds(threads, "code_review")).toEqual([
      "qa",
    ]);
  });
});
