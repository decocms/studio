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
  test("asks for a pull request and for the PR link, not a board move", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo);
    expect(prompt).toContain("open a pull request");
    expect(prompt).toContain("mcp__studio__TASK_BOARD_ITEM_PR_LINK");
    expect(prompt).toContain("(task id: tbi_1)");
    expect(prompt).not.toContain('status "in_review"');
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
    expect(prompt).toContain("TASK_BOARD_ITEM_PR_LINK");
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

  /** The link instruction is the one that names a command to run, so it is
   *  what must follow the checkout's provider. */
  const linkLine = (prompt: string) =>
    prompt.split("\n").find((l) => l.includes("TASK_BOARD_ITEM_PR_LINK")) ?? "";

  test("a GitLab run is told to run glab, and called a merge request", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, gitlabRepo);
    expect(prompt).toContain("hosted on GitLab, so `git` and `glab`");
    expect(linkLine(prompt)).toContain("glab mr create");
    expect(linkLine(prompt)).toContain("merge request");
    expect(linkLine(prompt)).not.toContain("gh pr create");
  });

  test("a GitHub run keeps gh and pull-request wording", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, repo);
    expect(prompt).toContain("hosted on GitHub, so `git` and `gh`");
    expect(linkLine(prompt)).toContain("gh pr create");
    expect(linkLine(prompt)).toContain("pull request");
    expect(linkLine(prompt)).not.toContain("glab mr create");
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
