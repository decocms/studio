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
import { runKeyPermissions } from "@/mcp-clients/virtual-mcp/mint-endpoint";
import { TOOL_BY_NAME } from "..";
import {
  REVIEW_RUN_TOOL_NAMES,
  JIRA_RUN_TOOL_NAMES,
  resolveThreadToolNames,
  RUN_SCOPED_TOOL_NAMES,
  TASK_RUN_TOOL_NAMES,
  THREAD_TOOL_NAMES,
} from "./task-run-context";

describe("resolveThreadToolNames", () => {
  test("a Reviewer run can record its decision", () => {
    expect(resolveThreadToolNames({ title: "Reviewer: Add an H1" })).toContain(
      "TASK_BOARD_REVIEW_DECISION",
    );
  });

  // An in-flight run from the two-reviewer era must not lose the decision tool
  // mid-run: unrecognised, its verdict has nowhere to go and the card stays In
  // Review forever.
  for (const legacy of ["QA Agent", "Code Reviewer"]) {
    test(`a ${legacy} run from before the merge still can`, () => {
      expect(
        resolveThreadToolNames({ title: `${legacy}: Add an H1` }),
      ).toContain("TASK_BOARD_REVIEW_DECISION");
    });
  }

  // The invariant the narrow list exists for: the worker must not be able to
  // approve or bounce its own work.
  test("a Super Agent run cannot record a review decision", () => {
    const names = resolveThreadToolNames({ title: "Super Agent: Add an H1" });
    expect(names).toEqual(THREAD_TOOL_NAMES);
    expect(names).not.toContain("TASK_BOARD_REVIEW_DECISION");
    expect(names).not.toContain("TASK_BOARD_PROMOTE_TO_PRODUCTION");
  });

  test("a chat, an unknown title, or a missing thread gets the chat surface", () => {
    for (const title of [null, undefined, "", "Some chat"]) {
      expect(resolveThreadToolNames({ title })).toEqual(THREAD_TOOL_NAMES);
    }
    expect(resolveThreadToolNames(null)).toEqual(THREAD_TOOL_NAMES);
  });

  // What Decopilot gave a chat as built-ins, now over MCP (spec §4).
  test("every chat gets the ported built-ins and the Studio tools it used", () => {
    for (const name of [
      "generate_image",
      "web_search",
      "deep_research",
      "suggest_task",
      "update_interests",
      "COLLECTION_THREADS_LIST",
      "COLLECTION_THREADS_GET",
      "COLLECTION_THREAD_MESSAGES_LIST",
      "TASK_BOARD_ITEM_CREATE",
      "COLLECTION_VIRTUAL_MCP_CREATE",
      "COLLECTION_CONNECTIONS_LIST",
      "COLLECTION_CONNECTIONS_GET",
    ] as const) {
      expect(THREAD_TOOL_NAMES).toContain(name);
    }
  });

  // `TASK_ADD_REPO` replaced `load_repo`, so a chat needs it as much as a run.
  test("the chat surface includes the whole task-run surface", () => {
    for (const name of TASK_RUN_TOOL_NAMES) {
      expect(THREAD_TOOL_NAMES).toContain(name);
    }
  });

  // Decopilot only ran these behind an approval, which this path lacks.
  test("a chat cannot rewrite the board's prompts or automations", () => {
    for (const name of [
      "TASK_BOARD_PROMPT_UPSERT",
      "TASK_BOARD_PROMPT_DELETE",
      "TASK_BOARD_AUTOMATION_UPSERT",
      "TASK_BOARD_AUTOMATION_DELETE",
    ] as const) {
      expect(THREAD_TOOL_NAMES).not.toContain(name);
    }
  });

  // `toolSubsetMCP` skips unknown names, so a typo would silently drop a tool.
  test("every name a thread can be served is a registered tool", () => {
    for (const name of [...THREAD_TOOL_NAMES, ...RUN_SCOPED_TOOL_NAMES]) {
      expect(TOOL_BY_NAME.has(name)).toBe(true);
    }
  });

  test("the chat-only tools are not run-scoped", () => {
    expect(RUN_SCOPED_TOOL_NAMES.has("COLLECTION_VIRTUAL_MCP_DELETE")).toBe(
      false,
    );
    expect(RUN_SCOPED_TOOL_NAMES.has("generate_image")).toBe(false);
    expect(RUN_SCOPED_TOOL_NAMES.has("TASK_ADD_REPO")).toBe(true);
  });

  // A reviewer needs to FIND the PR as well as rule on it: `enable_tool` came
  // back `not_found` for this one too, in every observed review.
  test("a reviewer can look up the task's PR", () => {
    expect(REVIEW_RUN_TOOL_NAMES).toContain("TASK_BOARD_ITEM_PRS_GET");
  });

  // Inverted from "a task run can look up the PR it opened". The board no
  // longer takes the run's word for its PR — it finds it by the branch the run
  // was given (`pr-by-branch.ts`), so a Super Agent run needs no PR tool.
  test("a task run does not look up its own PR", () => {
    expect(TASK_RUN_TOOL_NAMES).not.toContain("TASK_BOARD_ITEM_PRS_GET");
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
    const names = resolveThreadToolNames({
      title: "Jira EX-12: Fix the checkout button",
      metadata: { source: "jira" },
    });
    expect(names).toEqual(JIRA_RUN_TOOL_NAMES);
    expect(names).toContain("JIRA_COMMENT_ADD");
    expect(names.some((n: string) => n.startsWith("TASK_BOARD_"))).toBe(false);
  });

  test("the Jira stamp wins over a title that looks like a reviewer's", () => {
    expect(
      resolveThreadToolNames({
        title: "Reviewer: EX-12",
        metadata: { source: "jira" },
      }),
    ).toEqual(JIRA_RUN_TOOL_NAMES);
  });
});

/**
 * The run's KEY has to authorize everything the run's SERVER serves.
 *
 * These are two independent halves and they drifted: the key was minted from a
 * hardcoded `REVIEW_RUN_TOOL_NAMES` on the reasoning that it was a superset of
 * every run kind, which stopped being true the moment the Jira kind existed.
 * The endpoint served `JIRA_COMMENT_ADD`, the key did not authorize it, and the
 * first production Jira run did all its work and then got
 * "Access denied to: JIRA_COMMENT_ADD" on the one call that reports back.
 *
 * Asserted over every kind rather than for Jira alone, so a FOURTH kind cannot
 * reintroduce it.
 */
describe("a run's key covers the surface its endpoint serves", () => {
  const threads = {
    worker: { title: "Super Agent: Add an H1" },
    chat: { title: "Some chat" },
    reviewer: { title: "Reviewer: Add an H1" },
    jira: { title: "Jira ABC-1: x", metadata: { source: "jira" as const } },
  };

  for (const [kind, thread] of Object.entries(threads)) {
    test(`${kind}`, () => {
      const served = resolveThreadToolNames(thread);
      const authorized = runKeyPermissions({
        toolNames: served,
        grants: {},
      }).self;
      for (const tool of served) expect(authorized).toContain(tool);
    });
  }

  // The half that actually broke, stated on its own so the reason survives.
  test("a Jira run may comment on its issue", () => {
    expect(
      runKeyPermissions({
        toolNames: resolveThreadToolNames(threads.jira),
        grants: {},
      }).self,
    ).toContain("JIRA_COMMENT_ADD");
  });

  // Inverted: the reviewer list is no longer a superset of every kind, so
  // nothing may mint a key from it again.
  test("the reviewer list does not cover a Jira run", () => {
    expect(REVIEW_RUN_TOOL_NAMES).not.toContain("JIRA_COMMENT_ADD");
    expect(JIRA_RUN_TOOL_NAMES).toContain("JIRA_COMMENT_ADD");
  });
});
