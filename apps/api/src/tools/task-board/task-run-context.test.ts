/**
 * Which tools a run's MCP endpoint serves, by run thread.
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
  JIRA_RUN_TOOL_NAMES,
  resolveTaskRunToolNames,
  TASK_RUN_TOOL_NAMES,
} from "./task-run-context";

describe("resolveTaskRunToolNames", () => {
  test("a Reviewer run can record its decision", () => {
    expect(resolveTaskRunToolNames({ title: "Reviewer: Add an H1" })).toContain(
      "TASK_BOARD_REVIEW_DECISION",
    );
  });

  // An in-flight run from the two-reviewer era must not lose the decision tool
  // mid-run: unrecognised, its verdict has nowhere to go and the card stays In
  // Review forever.
  for (const legacy of ["QA Agent", "Code Reviewer"]) {
    test(`a ${legacy} run from before the merge still can`, () => {
      expect(
        resolveTaskRunToolNames({ title: `${legacy}: Add an H1` }),
      ).toContain("TASK_BOARD_REVIEW_DECISION");
    });
  }

  // The invariant the narrow list exists for: the worker must not be able to
  // approve or bounce its own work.
  test("a Super Agent run cannot record a review decision", () => {
    expect(
      resolveTaskRunToolNames({ title: "Super Agent: Add an H1" }),
    ).toEqual(TASK_RUN_TOOL_NAMES);
  });

  test("an unknown or missing title falls back to the narrow surface", () => {
    for (const title of [null, undefined, "", "Some chat"]) {
      expect(resolveTaskRunToolNames({ title: title })).toEqual(
        TASK_RUN_TOOL_NAMES,
      );
    }
  });

  // A reviewer needs to FIND the PR as well as rule on it: `enable_tool` came
  // back `not_found` for this one too, in every observed review.
  test("a reviewer can look up the task's PR", () => {
    expect(REVIEW_RUN_TOOL_NAMES).toContain("TASK_BOARD_ITEM_PRS_GET");
  });

  // Both inverted from "a task run can link / look up the PR it opened". The
  // board no longer takes the run's word for its PR — it finds it by the branch
  // the run was given (`pr-by-branch.ts`), so a Super Agent run needs neither
  // tool and `TASK_BOARD_ITEM_PR_LINK` no longer exists.
  test("a task run neither links nor looks up its own PR", () => {
    expect(TASK_RUN_TOOL_NAMES).not.toContain("TASK_BOARD_ITEM_PRS_GET");
    expect(TASK_RUN_TOOL_NAMES as readonly string[]).not.toContain(
      "TASK_BOARD_ITEM_PR_LINK",
    );
  });

  test("the review surface only ADDS to the narrow one", () => {
    for (const name of TASK_RUN_TOOL_NAMES) {
      expect(REVIEW_RUN_TOOL_NAMES).toContain(name);
    }
    expect(REVIEW_RUN_TOOL_NAMES).toHaveLength(TASK_RUN_TOOL_NAMES.length + 2);
  });

  // The card behind a Jira-triggered run is only its anchor. Serving the board
  // tools there would let the agent update a card nobody reads instead of the
  // issue everybody does — so the Jira surface has none of them.
  test("a Jira-triggered run gets the issue's tools and none of the board's", () => {
    const names = resolveTaskRunToolNames({
      title: "Jira EX-12: Fix the checkout button",
      metadata: { source: "jira" },
    });
    expect(names).toEqual(JIRA_RUN_TOOL_NAMES);
    expect(names).toContain("JIRA_COMMENT_ADD");
    expect(names.some((n) => n.startsWith("TASK_BOARD_"))).toBe(false);
  });

  test("the Jira stamp wins over a title that looks like a reviewer's", () => {
    expect(
      resolveTaskRunToolNames({
        title: "Reviewer: EX-12",
        metadata: { source: "jira" },
      }),
    ).toEqual(JIRA_RUN_TOOL_NAMES);
  });
});
