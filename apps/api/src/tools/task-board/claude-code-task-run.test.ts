import { describe, expect, test } from "bun:test";
import {
  buildClaudeCodeTaskPrompt,
  type TaskRepo,
} from "./claude-code-task-run";

const repo: TaskRepo = {
  connectionId: "conn_1",
  owner: "acme",
  name: "web",
  installationId: 42,
  url: "https://github.com/acme/web",
};

const task = {
  id: "tbi_1",
  title: "Add a health endpoint",
  description: "Return 200 from /healthz",
};

describe("buildClaudeCodeTaskPrompt", () => {
  test("states the task and that the repo is already checked out", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo);
    expect(prompt).toContain("Add a health endpoint");
    expect(prompt).toContain("Return 200 from /healthz");
    expect(prompt).toContain("acme/web is already cloned");
  });

  test("omits the description block when there is none", () => {
    const prompt = buildClaudeCodeTaskPrompt(
      { ...task, description: null },
      repo,
    );
    expect(prompt).not.toContain("Description:");
  });

  test("asks for a pull request and for the board move, with the task id", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo);
    expect(prompt).toContain("open a pull request");
    // The board move is the whole reason the run needs the Studio MCP.
    expect(prompt).toContain("mcp__studio__TASK_BOARD_ITEM_UPDATE");
    expect(prompt).toContain('id "tbi_1"');
    expect(prompt).toContain('"in_review"');
  });

  test("says it runs autonomously", () => {
    expect(buildClaudeCodeTaskPrompt(task, repo)).toContain("AUTONOMOUSLY");
  });

  test("reviewer feedback leads, and updates the existing PR", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo, {
      feedback: "Missing a test.",
      pr: { number: 7, url: "https://github.com/acme/web/pull/7" },
    });
    expect(prompt).toContain("Missing a test.");
    expect(prompt).toContain("gh pr checkout 7");
    expect(prompt).toContain("do NOT open a new one");
  });

  test("feedback with no PR asks for the fix without a checkout", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo, {
      feedback: "Wrong approach.",
    });
    expect(prompt).toContain("Wrong approach.");
    expect(prompt).not.toContain("gh pr checkout");
  });

  test("conflict resolution wins over feedback when both are set", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo, {
      feedback: "Missing a test.",
      resolveConflict: true,
      pr: { number: 9, url: "https://github.com/acme/web/pull/9" },
    });
    expect(prompt).toContain("MERGE CONFLICT");
    expect(prompt).toContain("gh pr checkout 9");
    expect(prompt).not.toContain("Missing a test.");
  });

  test("a conflict flag with no PR is ignored — nothing to check out", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo, {
      resolveConflict: true,
    });
    expect(prompt).not.toContain("MERGE CONFLICT");
  });

  test("a fresh attempt does not mention an existing PR", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo);
    expect(prompt).not.toContain("gh pr checkout");
    expect(prompt).not.toContain("existing one");
  });
});
