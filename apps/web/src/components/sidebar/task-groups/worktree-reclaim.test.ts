import { describe, expect, it } from "bun:test";
import type { Task } from "@/components/chat/task/types";
import {
  archiveConfirmSteps,
  hasOpenSiblingOnBranch,
  worktreeReclaimTarget,
} from "./worktree-reclaim";

const task = (
  over: Partial<{
    id: string;
    branch: string | null;
    virtual_mcp_id: string;
  }> = {},
) => ({
  id: "thread-1",
  branch: "feature/a",
  virtual_mcp_id: "vmcp-1",
  ...over,
});

describe("worktreeReclaimTarget", () => {
  it("is null off the desktop build even with a branch", () => {
    expect(worktreeReclaimTarget(task(), false)).toBeNull();
  });

  it("resolves the (thread, agent, branch) tuple on desktop", () => {
    expect(worktreeReclaimTarget(task(), true)).toEqual({
      taskId: "thread-1",
      virtualMcpId: "vmcp-1",
      branch: "feature/a",
    });
  });

  it("is null without a branch", () => {
    expect(worktreeReclaimTarget(task({ branch: null }), true)).toBeNull();
    expect(worktreeReclaimTarget(task({ branch: "   " }), true)).toBeNull();
  });

  it("is null without an agent — SANDBOX_DELETE has no address", () => {
    expect(
      worktreeReclaimTarget({ id: "t", branch: "feature/a" }, true),
    ).toBeNull();
  });
});

describe("archiveConfirmSteps", () => {
  it("performs NONE of the archive on cancel", () => {
    expect(archiveConfirmSteps("cancel")).toEqual([]);
  });

  it("archives before reclaiming on confirm", () => {
    expect(archiveConfirmSteps("confirm")).toEqual([
      "archive",
      "reclaim-worktree",
    ]);
  });

  it("never reclaims without archiving first", () => {
    for (const outcome of ["cancel", "confirm"] as const) {
      const steps = archiveConfirmSteps(outcome);
      const reclaim = steps.indexOf("reclaim-worktree");
      if (reclaim === -1) continue;
      expect(steps.indexOf("archive")).toBeLessThan(reclaim);
    }
  });
});

describe("hasOpenSiblingOnBranch", () => {
  const target = { taskId: "thread-1", virtualMcpId: "vmcp-1", branch: "b" };
  const feed = (over: Partial<Task> = {}) =>
    [
      {
        id: "thread-2",
        branch: "b",
        virtual_mcp_id: "vmcp-1",
        hidden: false,
        ...over,
      },
    ] as unknown as Task[];

  it("is true when another open chat shares the branch and agent", () => {
    expect(hasOpenSiblingOnBranch(feed(), target)).toBe(true);
  });

  it("ignores the thread being archived", () => {
    expect(hasOpenSiblingOnBranch(feed({ id: "thread-1" }), target)).toBe(
      false,
    );
  });

  it("ignores already-archived, other-branch and other-agent threads", () => {
    expect(hasOpenSiblingOnBranch(feed({ hidden: true }), target)).toBe(false);
    expect(hasOpenSiblingOnBranch(feed({ branch: "other" }), target)).toBe(
      false,
    );
    expect(
      hasOpenSiblingOnBranch(feed({ virtual_mcp_id: "vmcp-2" }), target),
    ).toBe(false);
  });

  // The desktop feed is complete, so this genuinely means "nobody else is on
  // the branch" — and is the ONLY thing that lets a confirm be offered.
  it("is false on an empty feed, which is what authorizes the reclaim prompt", () => {
    expect(hasOpenSiblingOnBranch([], target)).toBe(false);
  });
});
