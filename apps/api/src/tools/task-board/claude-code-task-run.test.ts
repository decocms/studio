import { describe, expect, test } from "bun:test";
import type { RepoChoice } from "@/git-providers/repo-choices";
import {
  buildClaudeCodeTaskPrompt,
  narrowToPreferredRepo,
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

  // A Jira run is told the issue, the pod's facts, and whatever its column
  // rule says — nothing else. The "how to finish / how to report" script that
  // used to be injected here is now two skills a person inserts into that
  // rule's prompt, where they can read and edit it.
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

    // Inverted: these lines used to be injected here. They now live in the
    // `jira-execute` / `jira-review` skills, so a run whose rule inserted
    // neither must not receive them anyway — that is the whole point of
    // making the prompt explicit.
    test("carries no built-in instruction on how to finish or report", () => {
      const prompt = buildClaudeCodeTaskPrompt(task, repo, jira);
      expect(prompt).not.toContain("How to finish:");
      expect(prompt).not.toContain("open a pull request");
      expect(prompt).not.toContain("JIRA_COMMENT_ADD` posts");
      expect(prompt).not.toContain("qa-screenshot");
      expect(prompt).not.toContain("org/output/");
    });

    // The one thing the author of that skill text cannot know: a skill names
    // tools bare so it works on either harness, and this is what stops a bare
    // name from costing the run a tool search.
    test("is told the Studio tool namespace as a fact", () => {
      const prompt = buildClaudeCodeTaskPrompt(task, repo, jira);
      expect(prompt).toContain("namespaced `mcp__studio__`");
      expect(prompt).toContain("mcp__studio__JIRA_COMMENT_ADD");
    });

    // The pod's own facts stay: nobody writing a column rule knows the repo,
    // the working directory, or that the checkout is shallow.
    test("still states the pod's facts", () => {
      const prompt = buildClaudeCodeTaskPrompt(task, repo, jira);
      expect(prompt).toContain("already cloned at your working directory");
      expect(prompt).toContain("SHALLOW");
    });

    // Inverted: there used to be a default Jira lead. A rule with no prompt
    // now gets no lead — the run reads the issue and its column's silence,
    // which is a legible outcome rather than a hidden one.
    test("has no lead of its own when the rule has no prompt", () => {
      const prompt = buildClaudeCodeTaskPrompt(task, repo, jira);
      expect(prompt.startsWith("You are running AUTONOMOUSLY")).toBe(true);
    });

    test("a rule's own prompt leads the run", () => {
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

/** A repository-backed choice, as `mergeRepoChoices` hands one over. */
const repositoryChoice = (id: string, owner: string, name: string) =>
  choice(id, owner, name, {
    repository: { id } as unknown as NonNullable<RepoChoice["repository"]>,
    connectionId: null,
    installationId: undefined,
  });

describe("narrowToPreferredRepo", () => {
  const choices = [
    repositoryChoice("repo_web", "acme", "web"),
    repositoryChoice("repo_api", "acme", "api"),
  ];

  test("a card that names nothing is not narrowed", () => {
    expect(narrowToPreferredRepo(choices)).toEqual(choices);
    expect(narrowToPreferredRepo(choices, {})).toEqual(choices);
    expect(
      narrowToPreferredRepo(choices, { repositoryId: null, repo: null }),
    ).toEqual(choices);
  });

  test("the id wins over a name that points somewhere else", () => {
    expect(
      narrowToPreferredRepo(choices, {
        repositoryId: "repo_api",
        repo: "acme/web",
      }).map((c) => c.id),
    ).toEqual(["repo_api"]);
  });

  test("an id that matches nothing falls through to the name", () => {
    expect(
      narrowToPreferredRepo(choices, {
        repositoryId: "repo_unlinked",
        repo: "acme/web",
      }).map((c) => c.id),
    ).toEqual(["repo_web"]);
  });

  test("an id that matches nothing, with no name, narrows to nothing", () => {
    expect(
      narrowToPreferredRepo(choices, { repositoryId: "repo_unlinked" }),
    ).toEqual([]);
  });

  test("a legacy choice carries no repository, so only its name can match", () => {
    const legacy = [choice("conn_1", "acme", "web")];
    expect(narrowToPreferredRepo(legacy, { repositoryId: "repo_web" })).toEqual(
      [],
    );
    expect(
      narrowToPreferredRepo(legacy, { repo: "acme/web" }).map((c) => c.id),
    ).toEqual(["conn_1"]);
  });
});

describe("pickSoleTaskRepo", () => {
  test("binds the reported repo from several choices and refuses missing or ambiguous matches", () => {
    const choices = [
      choice("one", "acme", "web"),
      choice("two", "acme", "api"),
    ];
    expect(pickSoleTaskRepo(choices, { repo: "ACME/API" })?.id).toBe("two");
    expect(pickSoleTaskRepo(choices, { repo: "other/repo" })).toBeNull();
    expect(
      pickSoleTaskRepo([...choices, choice("three", "acme", "api")], {
        repo: "acme/api",
      }),
    ).toBeNull();
  });

  test("the card's repository id binds a checkout a name could not tell apart", () => {
    const mirrored = [
      repositoryChoice("repo_github", "acme", "storefront"),
      choice("repo_gitlab", "acme", "storefront", {
        repository: {
          id: "repo_gitlab",
        } as unknown as NonNullable<RepoChoice["repository"]>,
        provider: "gitlab",
        connectionId: null,
        installationId: undefined,
        webUrl: "https://gitlab.acme.com/acme/storefront",
      }),
    ];
    expect(pickSoleTaskRepo(mirrored, { repo: "acme/storefront" })).toBeNull();
    expect(
      pickSoleTaskRepo(mirrored, {
        repositoryId: "repo_gitlab",
        repo: "acme/storefront",
      })?.id,
    ).toBe("repo_gitlab");
  });
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

  test("a Bitbucket run is told there is no CLI, and called a pull request", () => {
    const prompt = buildClaudeCodeTaskPrompt(task, {
      ...repo,
      provider: "bitbucket",
      url: "https://bitbucket.org/acme/site",
    });
    expect(prompt).toContain("hosted on Bitbucket, so `git` is authenticated");
    expect(prompt).toContain("BITBUCKET_TOKEN");
    expect(openLine(prompt)).toContain("pull request");
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
