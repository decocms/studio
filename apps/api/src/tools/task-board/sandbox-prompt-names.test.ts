import { describe, expect, test } from "bun:test";
import { REVIEWER_KINDS } from "@decocms/shared/task-board";
import {
  modeInstruction,
  sandboxRunPrompt,
} from "@/harnesses/sandbox-run-prompt";
import { DEFAULT_BOARD_PROMPTS } from "@/storage/task-board-default-prompts";
import { composeBoardPrompt } from "@/storage/task-board-prompts";
import type { TaskBoardItem } from "@/storage/types";
import {
  buildClaudeCodeTaskPrompt,
  type TaskRepo,
} from "./claude-code-task-run";
import { mentionInstruction } from "./comment-to-run";
import { missingVerdictPrompt } from "./enqueue-reviewer";
import { withBoardPrompt } from "./enqueue-task-run";
import { followUpPrompt } from "./reviewer-comment";
import { buildReviewerPrompt } from "./reviewer-run";
import { nudgePrompt } from "./stall-recovery";

// Each of these names a tool a sandbox run does not have under that name.
const STALE_NAMES = [
  "mcp__studio__",
  "`studio` MCP server",
  "user_ask",
  "subtask",
];

const repo: TaskRepo = {
  id: "conn_1",
  owner: "acme",
  name: "web",
  url: "https://github.com/acme/web",
  provider: "github",
};
const task = { id: "tbi_1", title: "Add a page", description: "Show /about" };
const pr = { number: 7, url: "https://github.com/acme/web/pull/7" };

const lane = (columnKey: string) =>
  composeBoardPrompt(
    DEFAULT_BOARD_PROMPTS.filter((p) => p.columnKey === columnKey),
  );

function builder(
  ...args: Parameters<typeof buildClaudeCodeTaskPrompt>
): string {
  const { system, message } = buildClaudeCodeTaskPrompt(...args);
  return `${message}\n\n${withBoardPrompt(system, lane("in_progress"))}`;
}

function reviewer(r: TaskRepo | null, priorReviewAt: number): string[] {
  return REVIEWER_KINDS.map((kind) => {
    const { instructions, prompt, system } = buildReviewerPrompt({
      task: { ...task, repo: "acme/web" },
      kind,
      repo: r,
      pinnedRepo: r ? null : "conn_1",
      priorReviewAt,
      reviewToken: "token",
    });
    return [
      instructions,
      prompt,
      withBoardPrompt(system, lane("in_review")),
    ].join("\n\n");
  });
}

const prompts: Record<string, string> = {
  "builder with repo": builder(task, repo),
  "builder without repo": builder(task, null, {
    repoChoices: [{ id: "conn_1", repo: "acme/web" }],
  }),
  "builder without repo or choices": builder(task, null),
  conflict: builder(task, repo, { pr, resolveConflict: true }),
  feedback: builder(task, repo, { pr, feedback: "Missing a test." }),
  "open pull request": builder(task, repo, { pr }),
  jira: builder(task, repo, {
    source: {
      kind: "jira",
      issueKeys: ["ABC-1"],
      title: "ABC-1",
      body: "# ABC-1",
    },
  }),
  ...Object.fromEntries(reviewer(repo, 0).map((p, i) => [`reviewer ${i}`, p])),
  ...Object.fromEntries(
    reviewer(null, 0).map((p, i) => [`reviewer no repo ${i}`, p]),
  ),
  ...Object.fromEntries(
    reviewer(repo, Date.UTC(2026, 0, 1)).map((p, i) => [`re-review ${i}`, p]),
  ),
  "stall nudge": nudgePrompt("claude-code"),
  "reviewer screenshot follow-up": followUpPrompt(),
  ...Object.fromEntries(
    REVIEWER_KINDS.map((kind) => [
      `missing verdict ${kind}`,
      missingVerdictPrompt(kind),
    ]),
  ),
  mention: mentionInstruction({ id: "tbi_1" } as TaskBoardItem, {
    commentId: "c1",
    body: "Please also fix the footer.",
    authorId: "u1",
    authorName: "A person",
    rootId: "c1",
  }),
  "chat modes and preview": [
    modeInstruction("gen-image"),
    modeInstruction("web-search"),
    modeInstruction("deep-research"),
    sandboxRunPrompt({
      mode: "default",
      threadId: "t",
      agentId: "a",
      userEmail: undefined,
      userContext: {},
      previewWatched: true,
    }),
  ].join("\n\n"),
};

describe("prompts a sandbox run receives from the task board", () => {
  for (const [name, text] of Object.entries(prompts)) {
    test(`${name} names no tool the run lacks`, () => {
      for (const stale of STALE_NAMES) expect(text).not.toContain(stale);
    });
  }

  test("configured skills render in the form the Skill tool accepts", () => {
    expect(prompts["builder with repo"]).toContain(
      "orgfs:orgfs-core-qa-screenshot",
    );
    expect(prompts["reviewer 0"]).toContain("orgfs:orgfs-core-qa-screenshot");
  });
});
