import { describe, expect, test } from "bun:test";
import type { RepoChoice } from "@/git-providers/repo-choices";
import {
  buildClaudeCodeTaskPrompt,
  pickSoleTaskRepo,
  type TaskRepo,
} from "./claude-code-task-run";

const repo: TaskRepo = {
  id: "conn_1",
  connectionId: "conn_1",
  owner: "acme",
  name: "web",
  installationId: 42,
  url: "https://github.com/acme/web",
  provider: "github",
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

  // The rule's own prompt was dropped on this path entirely — only the
  // Decopilot builder read it — so every Jira status rule and every by-hand
  // test run silently got the generic lead instead, on any org with a repo.
  test("leads with the caller's instruction when there is one", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo, {
      instruction: "Reproduce the bug, then fix it.",
    });
    expect(prompt.startsWith("Reproduce the bug, then fix it.")).toBe(true);
    expect(prompt).not.toContain("You've been assigned this task.");
  });

  test("falls back to the generic lead with no instruction", () => {
    expect(buildClaudeCodeTaskPrompt(task, repo)).toContain(
      "You've been assigned this task.",
    );
  });

  describe("a Jira-triggered run", () => {
    const jira = {
      source: {
        kind: "jira" as const,
        issueKey: "ABC-1",
        title: "Jira ABC-1: x",
        body: "# ABC-1",
      },
    };

    // It has no board tools (`JIRA_RUN_TOOL_NAMES`). Naming them sent the
    // first production run hunting for `TASK_BOARD_COMMENT_CREATE`, which its
    // endpoint does not serve.
    test("is never told to use a board tool", () => {
      const prompt = buildClaudeCodeTaskPrompt(task, repo, jira);
      expect(prompt).not.toContain("TASK_BOARD_");
    });

    // Prefixed the way the sandbox harness actually sees them: bare names cost
    // the run a tool search before it could report anything.
    test("is told to report on the issue, with namespaced tool names", () => {
      const prompt = buildClaudeCodeTaskPrompt(task, repo, jira);
      expect(prompt).toContain("mcp__studio__JIRA_COMMENT_ADD");
      expect(prompt).toContain("mcp__studio__JIRA_ISSUE_TRANSITION");
    });

    // The coding half is unchanged — a Jira run still opens a pull request.
    test("still opens a pull request from its own branch", () => {
      const prompt = buildClaudeCodeTaskPrompt(task, repo, jira);
      expect(prompt).toContain("open a pull request");
      expect(prompt).toContain("from the branch you were given");
    });

    // Inverted from the board rule. A Jira run's reviewer writes its verdict to
    // the hidden anchor card, so "a reviewer checks the preview after you hand
    // over" reports to nobody — this run is the only one that can check it.
    test("is told to verify on the deploy preview, not only locally", () => {
      const prompt = buildClaudeCodeTaskPrompt(task, repo, jira);
      expect(prompt).toContain("DEPLOY PREVIEW");
      expect(prompt).not.toContain("Do NOT wait for, or verify against");
    });

    test("is told how to get evidence onto the issue", () => {
      const prompt = buildClaudeCodeTaskPrompt(task, repo, jira);
      expect(prompt).toContain("org/output/");
      expect(prompt).toContain("mcp__studio__JIRA_REMOTE_LINK_ADD");
      expect(prompt).toContain("qa-screenshot");
    });

    // With no rule prompt the board's "you've been assigned this task" lead is
    // wrong: there is no task, there is an issue.
    test("leads with the Jira default when the rule has no prompt", () => {
      const prompt = buildClaudeCodeTaskPrompt(task, repo, jira);
      expect(prompt.startsWith("A Jira issue was moved into a column")).toBe(
        true,
      );
    });

    test("a rule's own prompt still wins over that default", () => {
      const prompt = buildClaudeCodeTaskPrompt(task, repo, {
        ...jira,
        instruction: "Only review, do not change code.",
      });
      expect(prompt.startsWith("Only review, do not change code.")).toBe(true);
    });
  });

  test("a board run keeps its board tools and its local-only verification", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo);
    expect(prompt).toContain("mcp__studio__TASK_BOARD_COMMENT_CREATE");
    expect(prompt).not.toContain("JIRA_");
    expect(prompt).toContain("Do NOT wait for, or verify against");
    expect(prompt).not.toContain("DEPLOY PREVIEW");
  });

  test("omits the description block when there is none", () => {
    const prompt = buildClaudeCodeTaskPrompt(
      { ...task, description: null },
      repo,
    );
    expect(prompt).not.toContain("Description:");
  });

  // Inverted with migration 190: the run used to be told to move its own card
  // to In Review after opening the PR. Linking the PR is what starts the
  // review now, and the card stays In Progress until the REVIEWER decides — so
  // asking the model for that move would put the card in the wrong lane for
  // the whole time an agent is still working on it.
  // Inverted: the run used to be told to report its own PR. The board finds it
  // by branch now (`pr-by-branch.ts`), so the prompt pins the BRANCH instead.
  test("asks for a pull request on the given branch, not a board move", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo);
    expect(prompt).toContain("open a pull request");
    expect(prompt).toContain("branch you were given");
    expect(prompt).toContain("(task id: tbi_1)");
    expect(prompt).not.toContain('status "in_review"');
  });

  // Inverted: the prompt used to assert "Nothing is installed and NO dev server
  // is running". Since #7016 a run can adopt its org's warm tenant pod — cloned,
  // installed and serving — and which pod it gets is decided by the claim, long
  // after this string is built. So the sandbox's state is stated at DISPATCH
  // (`sandboxStateInstruction`) and must not appear here at all.
  test("says nothing about installs or the dev server", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo);
    expect(prompt).not.toContain("dev server");
    expect(prompt).not.toContain("dependencies");
    // The globally-installed browser is a property of the IMAGE, true of both
    // kinds of pod, so that one line legitimately stays.
    expect(prompt).not.toContain("nothing is installed");
  });

  test("says it runs autonomously", () => {
    expect(buildClaudeCodeTaskPrompt(task, repo)).toContain("AUTONOMOUSLY");
  });

  // Inverted: this used to require fetching the PR's `previewUrl` and
  // verifying on the deploy preview. That is the reviewer's job — the Super
  // Agent implements and verifies locally, and must not sit waiting for a
  // deploy.
  test("requires reachability and a LOCAL check before handing over", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo);
    expect(prompt).toContain("must be REACHABLE");
    expect(prompt).toContain("VERIFY the task's outcome LOCALLY");
    expect(prompt).toContain("A green test suite is not the bar");
    expect(prompt).not.toContain("mcp__studio__TASK_BOARD_ITEM_PRS_GET");
  });

  // Inverted: this used to say "move it to review anyway so a human can close
  // it out". In Review is the reviewers' lane and reviewers are only enqueued
  // for a task that HAS a PR, so a no-PR task parked there had nobody to pick
  // it up — in prod every single In Review card was one of these, with zero
  // PRs and zero reviewer claims between them.
  test("a task needing no code change goes to done, not to a reviewer", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo);
    expect(prompt).toContain("no code change");
    expect(prompt).toContain('move it to "done"');
    expect(prompt).not.toContain("leave it for a reviewer anyway");
    // And it has to leave the reason where a human will read it.
    expect(prompt).toContain("mcp__studio__TASK_BOARD_COMMENT_CREATE");
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

  /**
   * A person re-delegating a card that already has an open PR. The sandbox
   * boots on that PR's branch, so the prompt must say continue-this-PR rather
   * than the default open-a-new-one.
   */
  test("a PR with no feedback leads with continue-this-PR", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo, {
      pr: { number: 7, url: "https://github.com/acme/web/pull/7" },
    });
    expect(prompt).toContain("already has an open pull request");
    expect(prompt).toContain("#7");
    expect(prompt).toContain("do NOT open a new one");
    expect(prompt).toContain("push to the existing one");
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

/** An active repo-scoped `mcp-github` connection, as `connections.list` returns it. */
const choice = (
  id: string,
  owner: string,
  name: string,
  overrides?: Partial<RepoChoice>,
): RepoChoice => ({
  id,
  owner,
  name,
  label: `${owner}/${name} (github.com)`,
  webUrl: `https://github.com/${owner}/${name}`,
  provider: "github" as const,
  repository: null,
  connectionId: id,
  installationId: 42,
  ...overrides,
});

describe("pickSoleTaskRepo", () => {
  test("no clonable repo is not eligible", () => {
    expect(pickSoleTaskRepo([])).toBeNull();
  });

  test("one repo, one legacy connection", () => {
    expect(pickSoleTaskRepo([choice("conn_1", "acme", "web")])).toEqual({
      id: "conn_1",
      connectionId: "conn_1",
      owner: "acme",
      name: "web",
      installationId: 42,
      url: "https://github.com/acme/web",
      provider: "github",
    });
  });

  /** A repository carries no connection and no installation, and its url is
   *  the provider's — so a GitLab one is dispatchable, which it was not while
   *  this read `mcp-github` connections. */
  test("one repository is bound by repositoryId, on its own host", () => {
    const repository = {
      id: "repo_1",
      host: "gitlab.acme.com",
      path: "group/sub/project",
    } as unknown as NonNullable<RepoChoice["repository"]>;
    expect(
      pickSoleTaskRepo([
        choice("repo_1", "group/sub", "project", {
          repository,
          provider: "gitlab",
          connectionId: null,
          installationId: undefined,
          webUrl: "https://gitlab.acme.com/group/sub/project",
        }),
      ]),
    ).toEqual({
      id: "repo_1",
      repositoryId: "repo_1",
      owner: "group/sub",
      name: "project",
      url: "https://gitlab.acme.com/group/sub/project",
      provider: "gitlab",
    });
  });

  // Two repos to choose between is the `TASK_ADD_REPO` path, not a dispatch-time bind.
  test("two different repos stay ambiguous", () => {
    expect(
      pickSoleTaskRepo([
        choice("conn_1", "acme", "web"),
        choice("conn_2", "acme", "api"),
      ]),
    ).toBeNull();
  });
});

describe("buildClaudeCodeTaskPrompt with no repo (several in the org)", () => {
  test("says the working directory is empty and to call TASK_ADD_REPO first", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, null);
    expect(prompt).toContain("EMPTY");
    expect(prompt).toContain("TASK_ADD_REPO");
    // The failure this wording exists to prevent: the model opening with a
    // file hunt in a directory nothing has cloned into yet.
    expect(prompt).toContain("Do not read files");
    expect(prompt).not.toContain("is already cloned");
  });

  test("still says how to finish", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, null);
    expect(prompt).toContain("branch you were given");
    expect(prompt).toContain('move it to "done"');
  });
});

describe("buildClaudeCodeTaskPrompt repo choices", () => {
  test("names the candidate repos so the run doesn't have to ask", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, null, {
      repoChoices: [
        { id: "conn_1", repo: "acme/web" },
        { id: "repo_api", repo: "acme/api" },
      ],
    });
    expect(prompt).toContain("acme/web (id: conn_1)");
    expect(prompt).toContain("acme/api (id: repo_api)");
    expect(prompt).toContain("Start with the one the task is about");
  });

  // Inverts "take the first": repositories accumulate now, so a task spanning
  // two of them adds a second checkout rather than swapping the first out.
  test("says a second add accumulates instead of replacing", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, null, {
      repoChoices: [
        { id: "conn_1", repo: "acme/web" },
        { id: "repo_api", repo: "acme/api" },
      ],
    });
    expect(prompt).not.toContain("take the first");
    expect(prompt).toContain("repositories accumulate");
    expect(prompt).toContain("one change request per repository");
  });

  test("falls back to the listing call when no candidates were resolved", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, null);
    expect(prompt).toContain("with no arguments to list them");
  });
});

describe("the prompt speaks each checkout's own provider", () => {
  const task = { id: "t1", title: "Fix it", description: null };
  const gitlabRepo: TaskRepo = {
    id: "repo_1",
    repositoryId: "repo_1",
    owner: "group/sub",
    name: "project",
    url: "https://gitlab.acme.com/group/sub/project",
    provider: "gitlab",
  };

  /**
   * The line telling the run to open the change request is the one that has to
   * name it the way its provider does — the board then finds it by branch.
   *
   * This used to assert on the `gh pr create` / `glab mr create` command in a
   * "call TASK_BOARD_ITEM_PR_LINK" instruction. That instruction is gone: the
   * board looks the change request up by the branch (`pr-by-branch.ts`)
   * instead of asking a run to report it, which a run that died right after
   * creating it could never do. The provider-specific WORDING is what
   * survived, so that is what this pins.
   */
  const openLine = (prompt: string) =>
    prompt
      .split("\n")
      .find((l) => l.includes("from the branch you were given")) ?? "";

  test("a GitLab run is told to run glab, and called a merge request", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, gitlabRepo);
    expect(prompt).toContain("hosted on GitLab, so `git` and `glab`");
    expect(openLine(prompt)).toContain("merge request");
    expect(openLine(prompt)).not.toContain("pull request");
  });

  test("a GitHub run keeps gh and pull-request wording", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo);
    expect(prompt).toContain("hosted on GitHub, so `git` and `gh`");
    expect(openLine(prompt)).toContain("pull request");
    expect(openLine(prompt)).not.toContain("merge request");
  });

  /** `TASK_ADD_REPO` accumulates checkouts, and they can be on different
   *  hosts — so the rule has to travel with every prompt, not just the
   *  several-repos one. */
  test("every prompt carries the per-checkout CLI rule", () => {
    for (const r of [repo, gitlabRepo, null]) {
      const prompt = buildClaudeCodeTaskPrompt(task, r);
      expect(prompt).toContain(
        "Each checkout is authenticated for ITS OWN host",
      );
      expect(prompt).toContain("`glab` inside a GitLab one");
    }
  });
});
