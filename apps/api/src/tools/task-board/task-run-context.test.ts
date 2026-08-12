/**
 * Which task-board tools a run's MCP endpoint serves, by run thread title.
 *
 * The bug this encodes: reviewer runs were told to finish by calling
 * `TASK_BOARD_REVIEW_DECISION` and never had it — reviews reached a verdict and
 * threw it away, leaving the task stuck In Review. The narrow surface must stay
 * narrow for a WORKER run (an agent must not approve its own work), so the two
 * lists are distinguished by the thread title the board itself assigned.
 */
import { describe, expect, test } from "bun:test";
import {
  REVIEW_RUN_TOOL_NAMES,
  resolveReviewRunToolNames,
  TASK_RUN_TOOL_NAMES,
} from "./task-run-context";

describe("resolveReviewRunToolNames", () => {
  test("a QA Agent run can record its decision", () => {
    expect(resolveReviewRunToolNames("QA Agent: Add an H1")).toContain(
      "TASK_BOARD_REVIEW_DECISION",
    );
  });

  test("a Code Reviewer run can record its decision", () => {
    expect(resolveReviewRunToolNames("Code Reviewer: Add an H1")).toContain(
      "TASK_BOARD_REVIEW_DECISION",
    );
  });

  // The invariant the narrow list exists for: the worker must not be able to
  // approve or bounce its own work.
  test("a Super Agent run cannot record a review decision", () => {
    expect(resolveReviewRunToolNames("Super Agent: Add an H1")).toEqual(
      TASK_RUN_TOOL_NAMES,
    );
  });

  test("an unknown or missing title falls back to the narrow surface", () => {
    for (const title of [null, undefined, "", "Some chat"]) {
      expect(resolveReviewRunToolNames(title)).toEqual(TASK_RUN_TOOL_NAMES);
    }
  });

  // A reviewer needs to FIND the PR as well as rule on it: `enable_tool` came
  // back `not_found` for this one too, in every observed review.
  test("both surfaces can look up the task's PR", () => {
    for (const list of [TASK_RUN_TOOL_NAMES, REVIEW_RUN_TOOL_NAMES]) {
      expect(list).toContain("TASK_BOARD_ITEM_PRS_GET");
    }
  });

  // Without this, a claude-code run has NO way to report the PR it opened (it
  // runs `gh pr create` in the pod, where no Studio hook can see it) and the
  // card strands In Review with no reviewer — see pr-link.ts.
  test("a task run can link the PR it opened", () => {
    expect(TASK_RUN_TOOL_NAMES).toContain("TASK_BOARD_ITEM_PR_LINK");
  });

  // A reviewer's surface is the task-run one plus exactly two: the verdict it
  // must record, and the screenshot tool it needs to exercise the PR preview
  // (the sandbox has no browser). Anything else creeping in is a widening of
  // what a run can reach and should be a deliberate edit here.
  test("the review surface only ADDS to the narrow one", () => {
    for (const name of TASK_RUN_TOOL_NAMES) {
      expect(REVIEW_RUN_TOOL_NAMES).toContain(name);
    }
    const added = REVIEW_RUN_TOOL_NAMES.filter(
      (name) => !TASK_RUN_TOOL_NAMES.includes(name),
    );
    expect(added).toEqual(["TASK_BOARD_REVIEW_DECISION", "TAKE_SCREENSHOT"]);
  });

  // QA has to show what it saw; the Super Agent writing the code does not, and
  // a screenshot tool on its surface is one more thing for it to wander into.
  test("only a reviewer gets the screenshot tool", () => {
    expect(TASK_RUN_TOOL_NAMES).not.toContain("TAKE_SCREENSHOT");
    expect(REVIEW_RUN_TOOL_NAMES).toContain("TAKE_SCREENSHOT");
  });
});
