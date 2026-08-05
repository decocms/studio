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

  test("the review surface only ADDS to the narrow one", () => {
    for (const name of TASK_RUN_TOOL_NAMES) {
      expect(REVIEW_RUN_TOOL_NAMES).toContain(name);
    }
    expect(REVIEW_RUN_TOOL_NAMES).toHaveLength(TASK_RUN_TOOL_NAMES.length + 1);
  });
});
