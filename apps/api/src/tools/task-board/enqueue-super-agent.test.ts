/**
 * Pure branch selection in the Super Agent prompt: a fresh attempt, a reviewer's
 * change request, or a merge-conflict resolution. The dispatch itself is
 * integration/e2e; this pins which lead block the prompt leads with — getting
 * that wrong sends the agent to re-do the task or open a second PR.
 */
import { describe, expect, it } from "bun:test";
import { buildSuperAgentTaskPrompt } from "./enqueue-super-agent";

const task = { id: "board_1", title: "Fix the thing", description: null };
const pr = { number: 7, url: "https://github.com/x/y/pull/7" };

const CONFLICT_LEAD = "MERGE CONFLICT";
const FEEDBACK_LEAD = "A reviewer requested changes";

describe("buildSuperAgentTaskPrompt", () => {
  it("a fresh attempt has neither lead block", () => {
    const p = buildSuperAgentTaskPrompt(task);
    expect(p).not.toContain(CONFLICT_LEAD);
    expect(p).not.toContain(FEEDBACK_LEAD);
    expect(p).toContain("Fix the thing");
    expect(p).toContain("(task id: board_1)");
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
