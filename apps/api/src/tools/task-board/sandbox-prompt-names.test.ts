import { describe, expect, test } from "bun:test";
import { agentMentionContext } from "@decocms/shared/agent-mention";
import { SANDBOX_STALE_NAMES } from "@decocms/shared/harness/sandbox-stale-names";
import { REVIEWER_KINDS } from "@decocms/shared/task-board";
import { sandboxStateInstruction } from "@/harnesses/sandbox-dispatch-client";
import { voiceRequestContext } from "@decocms/shared/voice";
import {
  modeInstruction,
  runIdentityParagraph,
  sandboxRunPrompt,
} from "@/harnesses/sandbox-run-prompt";
import { DEFAULT_BOARD_PROMPTS } from "@/storage/task-board-default-prompts";
import { composeBoardPrompt } from "@/storage/task-board-prompts";
import type { TaskBoardItem } from "@/storage/types";
import { getPrompts, getResources } from "@/tools/guides";
import { STUDIO_PACK_AGENTS } from "@/tools/virtual/studio-pack";
import { withVoiceResponseStyle } from "@/voice/prompt";
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

function voiceTurn(harnessId: string): string {
  const { parts } = withVoiceResponseStyle(
    {
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "Look into it." }],
    },
    true,
    harnessId,
    voiceRequestContext([{ role: "user", text: "And the second one?" }]),
  );
  return parts.map((p) => (p.type === "text" ? p.text : "")).join("\n\n");
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
      userEmail: undefined,
      userContext: {},
      audience: "owner",
      previewWatched: true,
    }),
  ].join("\n\n"),
  "agent mention": agentMentionContext({ title: "Sales", agentId: "vir_1" }),
  "voice turn on claude-code": voiceTurn("claude-code"),
  "voice turn on codex": voiceTurn("codex"),
  ...Object.fromEntries(
    STUDIO_PACK_AGENTS.map((agent) => [
      `studio pack agent ${agent.id}`,
      agent.instructions,
    ]),
  ),
  ...Object.fromEntries(
    getPrompts().map((guide) => [
      `guide prompt ${guide.name}`,
      typeof guide.text === "string" ? guide.text : guide.text({}),
    ]),
  ),
  ...Object.fromEntries(
    getResources().map((guide) => [`guide resource ${guide.uri}`, guide.text]),
  ),
  "project chat identity": runIdentityParagraph({
    kind: "project",
    title: "Example Storefront",
    description: "Sells example goods online.",
    organization: "Example Org",
    connections: ["Code Host"],
    connectionsViaStudio: true,
  }),
  "home chat identity": runIdentityParagraph({
    kind: "home",
    organization: "Example Org",
    reachesOrgConnections: true,
  }),
  "sandbox state without a repository": sandboxStateInstruction(false, {
    cwd: "/repo",
    branch: "sandbox/thread-t",
  }),
};

describe("prompts a sandbox run receives", () => {
  for (const [name, text] of Object.entries(prompts)) {
    test(`${name} names no tool the run lacks`, () => {
      expect(text).not.toBe("");
      for (const stale of SANDBOX_STALE_NAMES)
        expect(text).not.toContain(stale);
    });
  }

  test("a run with no repository is pointed at the tool by its bare name", () => {
    expect(prompts["sandbox state without a repository"]).toContain(
      "the Studio tool `TASK_ADD_REPO`",
    );
  });

  test("configured skills render in the form the Skill tool accepts", () => {
    expect(prompts["builder with repo"]).toContain(
      "orgfs:orgfs-core-qa-screenshot",
    );
    expect(prompts["reviewer 0"]).toContain("orgfs:orgfs-core-qa-screenshot");
  });
});
