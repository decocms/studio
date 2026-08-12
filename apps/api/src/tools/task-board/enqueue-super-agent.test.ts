/**
 * Pure branch selection in the Super Agent prompt: a fresh attempt, a reviewer's
 * change request, or a merge-conflict resolution. The dispatch itself is
 * integration/e2e; this pins which lead block the prompt leads with — getting
 * that wrong sends the agent to re-do the task or open a second PR.
 */
import { describe, expect, it } from "bun:test";
import {
  buildSuperAgentTaskPrompt,
  prStateIsPinnable,
} from "./enqueue-super-agent";

const task = { id: "board_1", title: "Fix the thing", description: null };
const pr = { number: 7, url: "https://github.com/x/y/pull/7" };

const CONFLICT_LEAD = "MERGE CONFLICT";
const FEEDBACK_LEAD = "A reviewer requested changes";
const CONTINUE_LEAD = "already has an open pull request";
const OPEN_A_PR = "commit on a new branch, push, and open a pull request";

describe("buildSuperAgentTaskPrompt", () => {
  it("a fresh attempt has no lead block, and opens a PR", () => {
    const p = buildSuperAgentTaskPrompt(task);
    expect(p).not.toContain(CONFLICT_LEAD);
    expect(p).not.toContain(FEEDBACK_LEAD);
    expect(p).not.toContain(CONTINUE_LEAD);
    expect(p).toContain(OPEN_A_PR);
    expect(p).toContain("Fix the thing");
    expect(p).toContain("(task id: board_1)");
  });

  /**
   * A person re-delegating a card with an open PR. The sandbox boots on that
   * PR's branch, so the prompt must not also say "open a pull request" — that
   * contradiction is what produced a third PR on three cards in one afternoon.
   */
  it("a PR with no feedback leads with continue-this-PR, and never says open one", () => {
    const p = buildSuperAgentTaskPrompt(task, { pr });
    expect(p).toContain(CONTINUE_LEAD);
    expect(p).toContain("#7");
    expect(p).toContain("do NOT open a new one");
    expect(p).not.toContain(OPEN_A_PR);
    expect(p).not.toContain(CONFLICT_LEAD);
    expect(p).not.toContain(FEEDBACK_LEAD);
  });

  it("feedback and conflict still win over the plain continue lead", () => {
    expect(
      buildSuperAgentTaskPrompt(task, { pr, feedback: "x" }),
    ).not.toContain(CONTINUE_LEAD);
    expect(
      buildSuperAgentTaskPrompt(task, { pr, resolveConflict: true }),
    ).not.toContain(CONTINUE_LEAD);
  });

  it("a conflict re-run leads with the conflict-resolution instruction", () => {
    const p = buildSuperAgentTaskPrompt(task, { pr, resolveConflict: true });
    expect(p).toContain(CONFLICT_LEAD);
    expect(p).toContain("gh pr checkout 7");
    expect(p).not.toContain(FEEDBACK_LEAD);
  });

  it("a reviewer change request leads with the feedback block", () => {
    const p = buildSuperAgentTaskPrompt(task, {
      pr,
      feedback: "QA Agent: the button is broken",
    });
    expect(p).toContain(FEEDBACK_LEAD);
    expect(p).toContain("the button is broken");
    expect(p).not.toContain(CONFLICT_LEAD);
  });

  it("conflict resolution wins over feedback when both are set", () => {
    const p = buildSuperAgentTaskPrompt(task, {
      pr,
      resolveConflict: true,
      feedback: "QA Agent: the button is broken",
    });
    expect(p).toContain(CONFLICT_LEAD);
    expect(p).not.toContain(FEEDBACK_LEAD);
  });

  it("resolveConflict without a PR skips the conflict lead (no PR to check out)", () => {
    // The callers always pair resolveConflict with a pr; this documents the
    // guard so a bad call can't emit a conflict instruction with no branch.
    const p = buildSuperAgentTaskPrompt(task, { resolveConflict: true });
    expect(p).not.toContain(CONFLICT_LEAD);
  });
});

/**
 * The bug: `openPrForTask` used to require `state === "open"`, so a throttled
 * or unreachable GitHub read (`readPrStateThrottled`'s `null`) silently fell
 * through to "no PR found" — the exact default, forking behavior this whole
 * path exists to prevent, just triggered by a read blip instead of a missing
 * PR.
 */
describe("prStateIsPinnable", () => {
  it("is true for open", () => {
    expect(prStateIsPinnable("open")).toBe(true);
  });

  it("is true for unknown (a GitHub read blip must not un-pin the branch)", () => {
    expect(prStateIsPinnable(null)).toBe(true);
  });

  it("is false for a definitively closed PR", () => {
    expect(prStateIsPinnable("closed")).toBe(false);
  });
});
